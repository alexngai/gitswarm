import { query } from '../config/database.js';
import crypto from 'crypto';

interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
}

interface PackageMetadata {
  description?: string;
  keywords?: string;
  license?: string;
  homepage?: string;
}

/**
 * Package Registry Service
 * Handles package publishing, versioning, and distribution
 */
export class PackageRegistryService {
  private db: DbClient | null;
  private query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  private storageType: string;
  private storageBucket: string;

  constructor(db: DbClient | null = null) {
    this.db = db;
    this.query = db?.query || query;

    // Storage configuration
    this.storageType = process.env.GITSWARM_PACKAGE_STORAGE || 'local';
    this.storageBucket = process.env.GITSWARM_PACKAGE_BUCKET || 'gitswarm-packages';
  }

  // ============================================================
  // Package Management
  // ============================================================

  /**
   * Create or get a package
   */
  async getOrCreatePackage(repoId: string, name: string, packageType: string, metadata: PackageMetadata = {}): Promise<Record<string, any>> {
    const result = await this.query(`
      INSERT INTO gitswarm_packages (repo_id, name, package_type, description, keywords, license, homepage)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (package_type, name) DO UPDATE SET
        description = COALESCE($4, gitswarm_packages.description),
        keywords = COALESCE($5, gitswarm_packages.keywords),
        license = COALESCE($6, gitswarm_packages.license),
        homepage = COALESCE($7, gitswarm_packages.homepage),
        updated_at = NOW()
      RETURNING *
    `, [
      repoId,
      name,
      packageType,
      metadata.description,
      metadata.keywords,
      metadata.license,
      metadata.homepage
    ]);

    return result.rows[0];
  }

  /**
   * Get package by type and name
   */
  async getPackage(packageType: string, name: string): Promise<Record<string, any> | null> {
    const result = await this.query(`
      SELECT p.*,
        r.github_full_name as repo_name,
        o.github_org_name as org_name
      FROM gitswarm_packages p
      JOIN gitswarm_repos r ON p.repo_id = r.id
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE p.package_type = $1 AND p.name = $2
    `, [packageType, name]);

    return result.rows[0] || null;
  }

  /**
   * Get package by ID
   */
  async getPackageById(packageId: string): Promise<Record<string, any> | null> {
    const result = await this.query(`
      SELECT p.*,
        r.github_full_name as repo_name,
        o.github_org_name as org_name
      FROM gitswarm_packages p
      JOIN gitswarm_repos r ON p.repo_id = r.id
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE p.id = $1
    `, [packageId]);

    return result.rows[0] || null;
  }

  /**
   * List packages with filters
   */
  async listPackages(filters: Record<string, any> = {}): Promise<any> {
    const {
      packageType,
      repoId,
      search,
      limit = 50,
      offset = 0
    } = filters;

    let whereClause = 'p.status = $1';
    const params = ['active'];
    let paramIndex = 2;

    if (packageType) {
      whereClause += ` AND p.package_type = $${paramIndex++}`;
      params.push(packageType);
    }

    if (repoId) {
      whereClause += ` AND p.repo_id = $${paramIndex++}`;
      params.push(repoId);
    }

    if (search) {
      whereClause += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    params.push(limit, offset);

    const result = await this.query(`
      SELECT p.*,
        r.github_full_name as repo_name,
        o.github_org_name as org_name
      FROM gitswarm_packages p
      JOIN gitswarm_repos r ON p.repo_id = r.id
      JOIN gitswarm_orgs o ON r.org_id = o.id
      WHERE ${whereClause}
      ORDER BY p.download_count DESC, p.created_at DESC
      LIMIT $${paramIndex - 1} OFFSET $${paramIndex}
    `, params);

    const countResult = await this.query(`
      SELECT COUNT(*) as total FROM gitswarm_packages p WHERE ${whereClause}
    `, params.slice(0, -2));

    return {
      packages: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset
    };
  }

  /**
   * Update package metadata
   */
  async updatePackage(packageId: string, updates: Record<string, any>): Promise<Record<string, any>> {
    const allowedFields = ['description', 'keywords', 'license', 'homepage', 'documentation_url'];
    const updateParts = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateParts.push(`${field} = $${paramIndex++}`);
        values.push(updates[field]);
      }
    }

    if (updateParts.length === 0) {
      throw new Error('No valid updates provided');
    }

    updateParts.push('updated_at = NOW()');
    values.push(packageId);

    const result = await this.query(`
      UPDATE gitswarm_packages SET ${updateParts.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    return result.rows[0];
  }

  /**
   * Deprecate a package
   */
  async _deprecatePackageSimple(packageId: string, message: string): Promise<Record<string, any>> {
    const result = await this.query(`
      UPDATE gitswarm_packages SET
        status = 'deprecated',
        deprecated_message = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [packageId, message]);

    return result.rows[0];
  }

  // ============================================================
  // Version Management
  // ============================================================

  /**
   * Publish a new version
   */
  async publishVersion(packageId: string, versionData: Record<string, any>, publisherId: string): Promise<Record<string, any>> {
    const {
      version,
      artifact,
      manifest = {},
      git_tag,
      git_commit_sha,
      prerelease = false
    } = versionData;

    // Validate version doesn't exist
    const existing = await this.query(`
      SELECT id FROM gitswarm_package_versions
      WHERE package_id = $1 AND version = $2
    `, [packageId, version]);

    if (existing.rows.length > 0) {
      throw new Error(`Version ${version} already exists`);
    }

    // Calculate checksum
    const checksum = artifact.checksum || this.calculateChecksum(artifact.content);

    // Store artifact (implementation depends on storage backend)
    const artifactUrl = await this.storeArtifact(packageId, version, artifact);

    // Parse dependencies from manifest
    const dependencies = this.extractDependencies(manifest);

    // Create version record
    const result = await this.query(`
      INSERT INTO gitswarm_package_versions (
        package_id, version, prerelease, git_tag, git_commit_sha,
        artifact_url, artifact_size, artifact_checksum,
        manifest, dependencies, dev_dependencies, peer_dependencies,
        published_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [
      packageId,
      version,
      prerelease,
      git_tag,
      git_commit_sha,
      artifactUrl,
      artifact.size,
      checksum,
      JSON.stringify(manifest),
      JSON.stringify(dependencies.dependencies || {}),
      JSON.stringify(dependencies.devDependencies || {}),
      JSON.stringify(dependencies.peerDependencies || {}),
      publisherId
    ]);

    // Update package's latest version
    if (!prerelease) {
      await this.query(`
        UPDATE gitswarm_packages SET
          latest_version = $2,
          latest_version_id = $3,
          version_count = version_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `, [packageId, version, result.rows[0].id]);
    } else {
      await this.query(`
        UPDATE gitswarm_packages SET
          version_count = version_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `, [packageId]);
    }

    return result.rows[0];
  }

  /**
   * Get a specific version
   */
  async getVersion(packageId: string, version: string): Promise<Record<string, any> | null> {
    const result = await this.query(`
      SELECT v.*,
        a.name as publisher_name
      FROM gitswarm_package_versions v
      LEFT JOIN agents a ON v.published_by = a.id
      WHERE v.package_id = $1 AND v.version = $2
    `, [packageId, version]);

    return result.rows[0] || null;
  }

  /**
   * List versions for a package
   */
  async listVersions(packageId: string, includeYanked: boolean = false): Promise<Record<string, any>[]> {
    let whereClause = 'v.package_id = $1';
    if (!includeYanked) {
      whereClause += ' AND v.yanked = false';
    }

    const result = await this.query(`
      SELECT v.*,
        a.name as publisher_name
      FROM gitswarm_package_versions v
      LEFT JOIN agents a ON v.published_by = a.id
      WHERE ${whereClause}
      ORDER BY v.created_at DESC
    `, [packageId]);

    return result.rows;
  }

  /**
   * Yank (soft delete) a version
   */
  async yankVersion(packageId: string, version: string, yankerId: string, reason: string): Promise<Record<string, any>> {
    const result = await this.query(`
      UPDATE gitswarm_package_versions SET
        yanked = true,
        yanked_at = NOW(),
        yanked_by = $3,
        yanked_reason = $4
      WHERE package_id = $1 AND version = $2
      RETURNING *
    `, [packageId, version, yankerId, reason]);

    if (result.rows.length === 0) {
      throw new Error('Version not found');
    }

    // If this was the latest version, update to the previous non-yanked version
    const pkg = await this.getPackageById(packageId);
    if (pkg && pkg.latest_version === version) {
      const latestNonYanked = await this.query(`
        SELECT id, version FROM gitswarm_package_versions
        WHERE package_id = $1 AND yanked = false AND prerelease = false
        ORDER BY created_at DESC
        LIMIT 1
      `, [packageId]);

      if (latestNonYanked.rows.length > 0) {
        await this.query(`
          UPDATE gitswarm_packages SET
            latest_version = $2,
            latest_version_id = $3
          WHERE id = $1
        `, [packageId, latestNonYanked.rows[0].version, latestNonYanked.rows[0].id]);
      } else {
        await this.query(`
          UPDATE gitswarm_packages SET
            latest_version = NULL,
            latest_version_id = NULL
          WHERE id = $1
        `, [packageId]);
      }
    }

    return result.rows[0];
  }

  /**
   * Unyank a version
   */
  async unYankVersion(packageId: string, version: string): Promise<Record<string, any>> {
    const result = await this.query(`
      UPDATE gitswarm_package_versions SET
        yanked = false,
        yanked_at = NULL,
        yanked_by = NULL,
        yanked_reason = NULL
      WHERE package_id = $1 AND version = $2
      RETURNING *
    `, [packageId, version]);

    return result.rows[0];
  }

  // ============================================================
  // Downloads
  // ============================================================

  /**
   * Record a download
   */
  async recordDownload(versionId: string, metadata: Record<string, any> = {}): Promise<void> {
    const { agentId, ipHash, userAgent, referrer } = metadata;

    // Record individual download
    await this.query(`
      INSERT INTO gitswarm_package_downloads (version_id, agent_id, ip_hash, user_agent, referrer)
      VALUES ($1, $2, $3, $4, $5)
    `, [versionId, agentId, ipHash, userAgent, referrer]);

    // Update version download count
    await this.query(`
      UPDATE gitswarm_package_versions SET download_count = download_count + 1
      WHERE id = $1
    `, [versionId]);

    // Update package download count
    await this.query(`
      UPDATE gitswarm_packages SET download_count = download_count + 1
      WHERE id = (SELECT package_id FROM gitswarm_package_versions WHERE id = $1)
    `, [versionId]);

    // Update daily stats
    await this.query(`
      INSERT INTO gitswarm_package_download_stats (package_id, date, downloads, unique_downloaders)
      VALUES (
        (SELECT package_id FROM gitswarm_package_versions WHERE id = $1),
        CURRENT_DATE,
        1,
        1
      )
      ON CONFLICT (package_id, date) DO UPDATE SET
        downloads = gitswarm_package_download_stats.downloads + 1,
        unique_downloaders = CASE
          WHEN $2 IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM gitswarm_package_downloads
            WHERE version_id IN (SELECT id FROM gitswarm_package_versions WHERE package_id = gitswarm_package_download_stats.package_id)
            AND ip_hash = $2
            AND downloaded_at::date = CURRENT_DATE
          )
          THEN gitswarm_package_download_stats.unique_downloaders + 1
          ELSE gitswarm_package_download_stats.unique_downloaders
        END
    `, [versionId, ipHash]);
  }

  /**
   * Get download stats for a package
   */
  async getDownloadStats(packageId: string, days: number = 30): Promise<Record<string, any>> {
    const result = await this.query(`
      SELECT date, downloads, unique_downloaders
      FROM gitswarm_package_download_stats
      WHERE package_id = $1 AND date >= CURRENT_DATE - $2
      ORDER BY date DESC
    `, [packageId, days]);

    const totals = await this.query(`
      SELECT
        SUM(downloads) as total_downloads,
        SUM(unique_downloaders) as total_unique
      FROM gitswarm_package_download_stats
      WHERE package_id = $1 AND date >= CURRENT_DATE - $2
    `, [packageId, days]);

    return {
      daily: result.rows,
      totals: {
        downloads: parseInt(totals.rows[0]?.total_downloads || 0),
        unique: parseInt(totals.rows[0]?.total_unique || 0)
      }
    };
  }

  // ============================================================
  // Maintainers
  // ============================================================

  /**
   * Add a package maintainer
   */
  async addMaintainer(packageId: string, agentId: string, role: string = 'maintainer', addedBy: string | null = null, permissions: Record<string, any> = {}): Promise<Record<string, any>> {
    const {
      can_publish = true,
      can_yank = true,
      can_add_maintainers = false,
      can_deprecate = false
    } = permissions;

    const result = await this.query(`
      INSERT INTO gitswarm_package_maintainers (
        package_id, agent_id, role, can_publish, can_yank, can_add_maintainers, can_deprecate, added_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (package_id, agent_id) DO UPDATE SET
        role = $3,
        can_publish = $4,
        can_yank = $5,
        can_add_maintainers = $6,
        can_deprecate = $7
      RETURNING *
    `, [packageId, agentId, role, can_publish, can_yank, can_add_maintainers, can_deprecate, addedBy]);

    return result.rows[0];
  }

  /**
   * Remove a package maintainer
   */
  async removeMaintainer(packageId: string, agentId: string): Promise<Record<string, any>> {
    const result = await this.query(`
      DELETE FROM gitswarm_package_maintainers
      WHERE package_id = $1 AND agent_id = $2
      RETURNING *
    `, [packageId, agentId]);

    return result.rows[0];
  }

  /**
   * List package maintainers
   */
  async listMaintainers(packageId: string): Promise<Record<string, any>[]> {
    const result = await this.query(`
      SELECT m.*, a.name as agent_name, a.avatar_url
      FROM gitswarm_package_maintainers m
      JOIN agents a ON m.agent_id = a.id
      WHERE m.package_id = $1
      ORDER BY m.role = 'owner' DESC, m.added_at
    `, [packageId]);

    return result.rows;
  }

  /**
   * Check if agent can perform action on package
   */
  async canPerform(agentId: string, packageId: string, action: string): Promise<{ allowed: boolean; reason: string }> {
    const maintainer = await this.query(`
      SELECT * FROM gitswarm_package_maintainers
      WHERE package_id = $1 AND agent_id = $2
    `, [packageId, agentId]);

    if (maintainer.rows.length === 0) {
      return { allowed: false, reason: 'not_maintainer' };
    }

    const m = maintainer.rows[0];

    switch (action) {
      case 'publish':
        return { allowed: m.can_publish, reason: m.can_publish ? 'allowed' : 'no_publish_permission' };
      case 'yank':
        return { allowed: m.can_yank, reason: m.can_yank ? 'allowed' : 'no_yank_permission' };
      case 'add_maintainer':
        return { allowed: m.can_add_maintainers, reason: m.can_add_maintainers ? 'allowed' : 'no_maintainer_permission' };
      case 'deprecate':
        return { allowed: m.can_deprecate, reason: m.can_deprecate ? 'allowed' : 'no_deprecate_permission' };
      default:
        return { allowed: false, reason: 'unknown_action' };
    }
  }

  // ============================================================
  // Security Advisories
  // ============================================================

  /**
   * Create a security advisory
   */
  async createAdvisory(packageId: string, data: Record<string, any>, reporterId: string): Promise<Record<string, any>> {
    const {
      title,
      description,
      severity,
      affected_versions,
      patched_versions,
      cve_id,
      cwe_ids,
      references
    } = data;

    const result = await this.query(`
      INSERT INTO gitswarm_package_advisories (
        package_id, title, description, severity, affected_versions,
        patched_versions, cve_id, cwe_ids, reported_by, references
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      packageId,
      title,
      description,
      severity,
      affected_versions,
      patched_versions,
      cve_id,
      cwe_ids,
      reporterId,
      JSON.stringify(references || [])
    ]);

    return result.rows[0];
  }

  /**
   * List advisories for a package
   */
  async listAdvisories(packageId: string): Promise<Record<string, any>[]> {
    const result = await this.query(`
      SELECT a.*, ag.name as reporter_name
      FROM gitswarm_package_advisories a
      LEFT JOIN agents ag ON a.reported_by = ag.id
      WHERE a.package_id = $1
      ORDER BY
        CASE a.severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        a.reported_at DESC
    `, [packageId]);

    return result.rows;
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Calculate SHA256 checksum of content
   */
  calculateChecksum(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Extract dependencies from package manifest
   */
  extractDependencies(manifest: Record<string, any>): { dependencies: Record<string, any>; devDependencies: Record<string, any>; peerDependencies: Record<string, any> } {
    // Handle different package types
    if (manifest.dependencies || manifest.devDependencies || manifest.peerDependencies) {
      // npm/Node.js style
      return {
        dependencies: manifest.dependencies || {},
        devDependencies: manifest.devDependencies || {},
        peerDependencies: manifest.peerDependencies || {}
      };
    }

    if (manifest.requires || manifest.install_requires) {
      // Python style
      return {
        dependencies: manifest.requires || manifest.install_requires || [],
        devDependencies: manifest.dev_requires || [],
        peerDependencies: {}
      };
    }

    if (manifest.dependencies && typeof manifest.dependencies === 'object') {
      // Cargo/Rust style
      return {
        dependencies: manifest.dependencies || {},
        devDependencies: manifest['dev-dependencies'] || {},
        peerDependencies: {}
      };
    }

    return {
      dependencies: {},
      devDependencies: {},
      peerDependencies: {}
    };
  }

  /**
   * Store artifact to storage backend
   * Returns the URL where the artifact can be downloaded
   */
  async storeArtifact(packageId: string, version: string, artifact: Record<string, any>): Promise<string> {
    // In production, this would upload to S3, GCS, etc.
    // For now, return a placeholder URL
    const key = `${packageId}/${version}/${artifact.filename || 'package.tar.gz'}`;

    switch (this.storageType) {
      case 's3':
        return `https://${this.storageBucket}.s3.amazonaws.com/${key}`;
      case 'gcs':
        return `https://storage.googleapis.com/${this.storageBucket}/${key}`;
      default:
        return `/packages/${key}`;
    }
  }

  // ============================================================
  // Package Deprecation
  // ============================================================

  /**
   * Deprecate a package
   */
  async deprecatePackage(packageId: string, agentId: string, message: string | null = null, alternative: string | null = null): Promise<Record<string, any>> {
    const pkg = await this.query(`
      SELECT id, deprecated FROM gitswarm_packages WHERE id = $1
    `, [packageId]);

    if (pkg.rows.length === 0) {
      throw new Error('Package not found');
    }

    if (pkg.rows[0].deprecated) {
      throw new Error('Package is already deprecated');
    }

    const result = await this.query(`
      UPDATE gitswarm_packages SET
        deprecated = true,
        deprecated_at = NOW(),
        deprecated_by = $2,
        deprecation_message = $3,
        deprecated_alternative = $4,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [packageId, agentId, message, alternative]);

    return {
      success: true,
      package: result.rows[0],
      message: 'Package has been deprecated'
    };
  }

  /**
   * Undeprecate a package
   */
  async undeprecatePackage(packageId: string, agentId: string): Promise<Record<string, any>> {
    const pkg = await this.query(`
      SELECT id, deprecated FROM gitswarm_packages WHERE id = $1
    `, [packageId]);

    if (pkg.rows.length === 0) {
      throw new Error('Package not found');
    }

    if (!pkg.rows[0].deprecated) {
      throw new Error('Package is not deprecated');
    }

    const result = await this.query(`
      UPDATE gitswarm_packages SET
        deprecated = false,
        deprecated_at = NULL,
        deprecated_by = NULL,
        deprecation_message = NULL,
        deprecated_alternative = NULL,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [packageId]);

    return {
      success: true,
      package: result.rows[0],
      message: 'Package is no longer deprecated'
    };
  }
}

// Export singleton instance
export const packageRegistry = new PackageRegistryService();
