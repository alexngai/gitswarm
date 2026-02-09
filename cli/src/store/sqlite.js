import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { schemaV1, migrations } from './schema.js';

/**
 * SQLite store with a PostgreSQL-compatible query interface.
 *
 * The web app services use parameterised queries written for pg (`$1`, `$2` …).
 * This adapter translates them on the fly so the same service classes can run
 * against a local SQLite database without modification.
 */
export class SqliteStore {
  constructor(dbPath) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Run versioned migrations.
   *
   * Checks schema_version table (creates it if needed) and applies
   * any migrations that haven't been run yet.  For fresh databases
   * this runs all migrations in order.
   */
  migrate() {
    const currentVersion = this._getCurrentVersion();

    for (const { version, sql } of migrations) {
      if (version <= currentVersion) continue;
      this.db.exec(sql);
    }
  }

  /**
   * PostgreSQL-compatible query() interface.
   *
   * Accepts SQL with `$1 … $N` positional params and returns
   * `{ rows: [...] }` just like node-pg.
   */
  query(sql, params = []) {
    const translated = this._translateSql(sql);

    // Determine whether this is a read or write.
    const trimmed = translated.trimStart().toUpperCase();
    const isRead = trimmed.startsWith('SELECT');
    const hasReturning = /\bRETURNING\b/i.test(translated);

    // SQLite 3.35+ (bundled with better-sqlite3 v9+) supports RETURNING
    // natively — treat these as reads since they return rows.
    if (isRead || hasReturning) {
      const stmt = this.db.prepare(translated);
      const rows = stmt.all(...params);
      return { rows };
    }

    // Plain write (INSERT / UPDATE / DELETE without RETURNING).
    const info = this.db.prepare(translated).run(...params);
    return { rows: [], changes: info.changes };
  }

  /** Run a callback inside a transaction. */
  transaction(fn) {
    return this.db.transaction(fn)();
  }

  close() {
    this.db.close();
  }

  // ── internal helpers ──────────────────────────────────────────

  /**
   * Get the current schema version from the database.
   * Returns 0 if schema_version table doesn't exist yet.
   */
  _getCurrentVersion() {
    try {
      const row = this.db
        .prepare(`SELECT MAX(version) as v FROM schema_version`)
        .get();
      return row?.v || 0;
    } catch {
      // Table doesn't exist yet — fresh database
      return 0;
    }
  }

  /**
   * Translate PostgreSQL dialect to SQLite dialect:
   *  - `$1, $2 …` → `?`
   *  - `NOW()` → `datetime('now')`
   *  - `INTERVAL '…'` → `datetime('now', '-…')`  (handled in context)
   *  - `… FILTER (WHERE …)` → `SUM(CASE WHEN … THEN 1 ELSE 0 END)`
   *  - `::type` casts → removed
   *  - `ON CONFLICT … DO UPDATE SET` → kept (SQLite supports UPSERT)
   *  - `ILIKE` → `LIKE` (SQLite LIKE is case-insensitive for ASCII)
   */
  _translateSql(sql) {
    let out = sql;

    // $N → ?  (must preserve ordering – they're already in order)
    out = out.replace(/\$\d+/g, '?');

    // NOW() → datetime('now')
    out = out.replace(/\bNOW\(\)/gi, "datetime('now')");

    // NOW() - INTERVAL 'N days/hours/etc'
    out = out.replace(
      /datetime\('now'\)\s*-\s*INTERVAL\s*'(\d+)\s*(day|days|hour|hours|minute|minutes|second|seconds|month|months|year|years|week|weeks)'/gi,
      (_, n, unit) => {
        const u = unit.toLowerCase().replace(/s$/, '');
        return `datetime('now', '-${n} ${u}')`;
      }
    );

    // COUNT(*) FILTER (WHERE cond) → SUM(CASE WHEN cond THEN 1 ELSE 0 END)
    out = out.replace(
      /COUNT\(\*\)\s*FILTER\s*\(\s*WHERE\s+(.+?)\)/gi,
      (_, cond) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`
    );

    // ::text, ::integer etc casts
    out = out.replace(/::\w+/g, '');

    // ILIKE → LIKE
    out = out.replace(/\bILIKE\b/gi, 'LIKE');

    // true/false literals (PG) → 1/0 (SQLite)
    out = out.replace(/\b= true\b/gi, '= 1');
    out = out.replace(/\b= false\b/gi, '= 0');
    out = out.replace(/\bIS true\b/gi, '= 1');
    out = out.replace(/\bIS false\b/gi, '= 0');

    return out;
  }

}
