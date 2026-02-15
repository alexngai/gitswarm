/**
 * Shared ID generation for GitSwarm.
 *
 * Standardizes on 36-character UUIDs with dashes across both CLI (SQLite)
 * and web server (PostgreSQL). This ensures IDs generated on any level
 * can be used in joins and lookups without transformation.
 *
 * PostgreSQL also uses gen_random_uuid() for DB-level defaults,
 * but application-generated IDs should use this module.
 */
import { randomUUID } from 'node:crypto';

/**
 * Generate a new UUID (36-character with dashes).
 * @returns e.g. 'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6'
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Validate that a string is a well-formed UUID or a legacy 32-char hex ID.
 * Accepts both formats during the migration period.
 */
export function isValidId(id: unknown): boolean {
  if (!id || typeof id !== 'string') return false;
  // Standard UUID: 36 chars with dashes
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return true;
  // Legacy 32-char hex (accepted for backwards compat)
  if (/^[0-9a-f]{32}$/i.test(id)) return true;
  return false;
}

/**
 * Convert a legacy 32-char hex ID to UUID format by inserting dashes.
 * Returns the input unchanged if it's already a UUID or not a valid hex ID.
 */
export function normalizeId(id: string): string {
  if (!id || typeof id !== 'string') return id;
  if (id.length === 32 && /^[0-9a-f]{32}$/i.test(id)) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  return id;
}
