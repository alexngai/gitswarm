import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PackageRegistryService } from '../../src/services/package-registry.js';

describe('PackageRegistryService', () => {
  let service;
  let mockQuery;

  beforeEach(() => {
    mockQuery = vi.fn();
    service = new PackageRegistryService({ query: mockQuery });
  });

  // ============================================================
  // Package Management
  // ============================================================

  describe('getOrCreatePackage', () => {
    it('should create a new package', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'pkg-1',
          repo_id: 'repo-1',
          name: 'my-package',
          package_type: 'npm',
          description: 'A test package',
          status: 'active'
        }]
      });

      const result = await service.getOrCreatePackage('repo-1', 'my-package', 'npm', {
        description: 'A test package',
        license: 'MIT'
      });

      expect(result.name).toBe('my-package');
      expect(result.package_type).toBe('npm');
    });

    it('should update existing package on conflict', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'pkg-1',
          name: 'existing-package',
          description: 'Updated description'
        }]
      });

      const result = await service.getOrCreatePackage('repo-1', 'existing-package', 'npm', {
        description: 'Updated description'
      });

      expect(result.description).toBe('Updated description');
    });
  });

  describe('getPackage', () => {
    it('should return package with repo and org info', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'pkg-1',
          name: 'my-package',
          package_type: 'npm',
          repo_name: 'org/repo',
          org_name: 'org'
        }]
      });

      const result = await service.getPackage('npm', 'my-package');

      expect(result.name).toBe('my-package');
      expect(result.repo_name).toBe('org/repo');
    });

    it('should return null for non-existent package', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.getPackage('npm', 'non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getPackageById', () => {
    it('should return package by ID', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'pkg-1',
          name: 'my-package',
          repo_name: 'org/repo',
          org_name: 'org'
        }]
      });

      const result = await service.getPackageById('pkg-1');

      expect(result.id).toBe('pkg-1');
    });

    it('should return null for non-existent ID', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.getPackageById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listPackages', () => {
    it('should list packages with default pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { id: 'pkg-1', name: 'package-a' },
            { id: 'pkg-2', name: 'package-b' }
          ]
        })
        .mockResolvedValueOnce({ rows: [{ total: '10' }] });

      const result = await service.listPackages();

      expect(result.packages).toHaveLength(2);
      expect(result.total).toBe(10);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should filter by package type', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pkg-1', name: 'npm-package' }] })
        .mockResolvedValueOnce({ rows: [{ total: '5' }] });

      const result = await service.listPackages({ packageType: 'npm' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('p.package_type = $2'),
        expect.arrayContaining(['active', 'npm'])
      );
    });

    it('should filter by repo ID', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] });

      await service.listPackages({ repoId: 'repo-123' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('p.repo_id = $'),
        expect.arrayContaining(['active', 'repo-123'])
      );
    });

    it('should search by name and description', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'pkg-1', name: 'utils' }] })
        .mockResolvedValueOnce({ rows: [{ total: '1' }] });

      await service.listPackages({ search: 'utils' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%utils%'])
      );
    });

    it('should handle custom pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: '100' }] });

      const result = await service.listPackages({ limit: 20, offset: 40 });

      expect(result.limit).toBe(20);
      expect(result.offset).toBe(40);
    });
  });

  describe('updatePackage', () => {
    it('should update allowed fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'pkg-1',
          description: 'New description',
          license: 'Apache-2.0'
        }]
      });

      const result = await service.updatePackage('pkg-1', {
        description: 'New description',
        license: 'Apache-2.0'
      });

      expect(result.description).toBe('New description');
    });

    it('should throw error when no valid updates', async () => {
      await expect(service.updatePackage('pkg-1', {
        invalid_field: 'value'
      })).rejects.toThrow('No valid updates provided');
    });
  });

  describe('deprecatePackage', () => {
    it('should deprecate package with message', async () => {
      // Check package exists and is not deprecated
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pkg-1', deprecated: false }]
      });
      // Update package
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'pkg-1',
          deprecated: true,
          deprecation_message: 'Use v2 instead',
          deprecated_alternative: '@new/package'
        }]
      });

      const result = await service.deprecatePackage('pkg-1', 'agent-uuid', 'Use v2 instead', '@new/package');

      expect(result.success).toBe(true);
      expect(result.package.deprecated).toBe(true);
      expect(result.package.deprecation_message).toBe('Use v2 instead');
    });

    it('should reject if package already deprecated', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pkg-1', deprecated: true }]
      });

      await expect(service.deprecatePackage('pkg-1', 'agent-uuid', 'message'))
        .rejects.toThrow('already deprecated');
    });

    it('should reject if package not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.deprecatePackage('bad-pkg', 'agent-uuid', 'message'))
        .rejects.toThrow('not found');
    });
  });

  describe('undeprecatePackage', () => {
    it('should undeprecate a deprecated package', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pkg-1', deprecated: true }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pkg-1', deprecated: false }]
      });

      const result = await service.undeprecatePackage('pkg-1', 'agent-uuid');

      expect(result.success).toBe(true);
      expect(result.package.deprecated).toBe(false);
    });

    it('should reject if package not deprecated', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'pkg-1', deprecated: false }]
      });

      await expect(service.undeprecatePackage('pkg-1', 'agent-uuid'))
        .rejects.toThrow('not deprecated');
    });
  });

  // ============================================================
  // Version Management
  // ============================================================

  describe('publishVersion', () => {
    it('should publish a new version', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // check existing version
        .mockResolvedValueOnce({
          rows: [{
            id: 'ver-1',
            version: '1.0.0',
            prerelease: false,
            artifact_url: '/packages/pkg-1/1.0.0/package.tar.gz'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // update latest version

      const result = await service.publishVersion('pkg-1', {
        version: '1.0.0',
        artifact: { filename: 'package.tar.gz', size: 1024, checksum: 'abc123' },
        manifest: { name: 'my-package' }
      }, 'agent-1');

      expect(result.version).toBe('1.0.0');
      expect(result.prerelease).toBe(false);
    });

    it('should publish prerelease version', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'ver-1',
            version: '2.0.0-beta.1',
            prerelease: true
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.publishVersion('pkg-1', {
        version: '2.0.0-beta.1',
        artifact: { filename: 'package.tar.gz', size: 1024, checksum: 'abc123def456' },
        prerelease: true
      }, 'agent-1');

      expect(result.prerelease).toBe(true);
    });

    it('should throw error for existing version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ver-existing' }] });

      await expect(service.publishVersion('pkg-1', {
        version: '1.0.0',
        artifact: { filename: 'package.tar.gz', size: 1024 }
      }, 'agent-1')).rejects.toThrow('Version 1.0.0 already exists');
    });

    it('should include git tag and commit sha', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'ver-1',
            version: '1.0.0',
            git_tag: 'v1.0.0',
            git_commit_sha: 'abc123def456'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.publishVersion('pkg-1', {
        version: '1.0.0',
        artifact: { filename: 'package.tar.gz', size: 1024, checksum: 'sha256hash' },
        git_tag: 'v1.0.0',
        git_commit_sha: 'abc123def456'
      }, 'agent-1');

      expect(result.git_tag).toBe('v1.0.0');
    });
  });

  describe('getVersion', () => {
    it('should return version with publisher info', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'ver-1',
          version: '1.0.0',
          publisher_name: 'Agent Smith',
          artifact_url: '/packages/pkg-1/1.0.0/package.tar.gz'
        }]
      });

      const result = await service.getVersion('pkg-1', '1.0.0');

      expect(result.version).toBe('1.0.0');
      expect(result.publisher_name).toBe('Agent Smith');
    });

    it('should return null for non-existent version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.getVersion('pkg-1', '99.0.0');

      expect(result).toBeNull();
    });
  });

  describe('listVersions', () => {
    it('should list non-yanked versions by default', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { version: '1.1.0', yanked: false },
          { version: '1.0.0', yanked: false }
        ]
      });

      const result = await service.listVersions('pkg-1');

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('v.yanked = false'),
        ['pkg-1']
      );
    });

    it('should include yanked versions when requested', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { version: '1.1.0', yanked: false },
          { version: '1.0.0', yanked: true }
        ]
      });

      const result = await service.listVersions('pkg-1', true);

      expect(result).toHaveLength(2);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.not.stringContaining('v.yanked = false'),
        ['pkg-1']
      );
    });
  });

  describe('yankVersion', () => {
    it('should yank a version', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'ver-1',
            version: '1.0.0',
            yanked: true,
            yanked_reason: 'Security vulnerability'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'pkg-1',
            latest_version: '1.1.0'
          }]
        }); // getPackageById - version is not the latest

      const result = await service.yankVersion('pkg-1', '1.0.0', 'agent-1', 'Security vulnerability');

      expect(result.yanked).toBe(true);
      expect(result.yanked_reason).toBe('Security vulnerability');
    });

    it('should update latest version when yanking the latest', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'ver-1',
            version: '2.0.0',
            yanked: true
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'pkg-1',
            latest_version: '2.0.0'
          }]
        })
        .mockResolvedValueOnce({
          rows: [{ id: 'ver-0', version: '1.0.0' }]
        }) // find previous non-yanked
        .mockResolvedValueOnce({ rowCount: 1 }); // update package

      await service.yankVersion('pkg-1', '2.0.0', 'agent-1', 'Bug');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE gitswarm_packages SET'),
        ['pkg-1', '1.0.0', 'ver-0']
      );
    });

    it('should clear latest version when all versions yanked', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'ver-1',
            version: '1.0.0',
            yanked: true
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'pkg-1',
            latest_version: '1.0.0'
          }]
        })
        .mockResolvedValueOnce({ rows: [] }) // no non-yanked versions
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.yankVersion('pkg-1', '1.0.0', 'agent-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('latest_version = NULL'),
        ['pkg-1']
      );
    });

    it('should throw error for non-existent version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.yankVersion('pkg-1', '99.0.0', 'agent-1')).rejects.toThrow('Version not found');
    });
  });

  describe('unYankVersion', () => {
    it('should unyank a version', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'ver-1',
          version: '1.0.0',
          yanked: false,
          yanked_at: null
        }]
      });

      const result = await service.unYankVersion('pkg-1', '1.0.0');

      expect(result.yanked).toBe(false);
    });
  });

  // ============================================================
  // Downloads
  // ============================================================

  describe('recordDownload', () => {
    it('should record download with metadata', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 1 }) // insert download
        .mockResolvedValueOnce({ rowCount: 1 }) // update version count
        .mockResolvedValueOnce({ rowCount: 1 }) // update package count
        .mockResolvedValueOnce({ rowCount: 1 }); // update daily stats

      await service.recordDownload('ver-1', {
        agentId: 'agent-1',
        ipHash: 'abc123',
        userAgent: 'npm/8.0.0',
        referrer: 'https://example.com'
      });

      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gitswarm_package_downloads'),
        ['ver-1', 'agent-1', 'abc123', 'npm/8.0.0', 'https://example.com']
      );
    });

    it('should record download without metadata', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.recordDownload('ver-1', {});

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gitswarm_package_downloads'),
        ['ver-1', undefined, undefined, undefined, undefined]
      );
    });
  });

  describe('getDownloadStats', () => {
    it('should return daily stats and totals', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            { date: '2024-01-03', downloads: 100, unique_downloaders: 50 },
            { date: '2024-01-02', downloads: 80, unique_downloaders: 40 }
          ]
        })
        .mockResolvedValueOnce({
          rows: [{ total_downloads: '500', total_unique: '200' }]
        });

      const result = await service.getDownloadStats('pkg-1', 30);

      expect(result.daily).toHaveLength(2);
      expect(result.totals.downloads).toBe(500);
      expect(result.totals.unique).toBe(200);
    });

    it('should handle empty stats', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] });

      const result = await service.getDownloadStats('pkg-1');

      expect(result.daily).toEqual([]);
      expect(result.totals.downloads).toBe(0);
      expect(result.totals.unique).toBe(0);
    });

    it('should use default 30 days', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{}] });

      await service.getDownloadStats('pkg-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('CURRENT_DATE - $2'),
        ['pkg-1', 30]
      );
    });
  });

  // ============================================================
  // Maintainers
  // ============================================================

  describe('addMaintainer', () => {
    it('should add maintainer with default permissions', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          package_id: 'pkg-1',
          agent_id: 'agent-1',
          role: 'maintainer',
          can_publish: true,
          can_yank: true,
          can_add_maintainers: false,
          can_deprecate: false
        }]
      });

      const result = await service.addMaintainer('pkg-1', 'agent-1');

      expect(result.role).toBe('maintainer');
      expect(result.can_publish).toBe(true);
      expect(result.can_add_maintainers).toBe(false);
    });

    it('should add owner with full permissions', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          package_id: 'pkg-1',
          agent_id: 'agent-1',
          role: 'owner',
          can_publish: true,
          can_yank: true,
          can_add_maintainers: true,
          can_deprecate: true
        }]
      });

      const result = await service.addMaintainer('pkg-1', 'agent-1', 'owner', null, {
        can_publish: true,
        can_yank: true,
        can_add_maintainers: true,
        can_deprecate: true
      });

      expect(result.role).toBe('owner');
      expect(result.can_add_maintainers).toBe(true);
    });

    it('should track who added the maintainer', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          package_id: 'pkg-1',
          agent_id: 'agent-2',
          added_by: 'agent-1'
        }]
      });

      await service.addMaintainer('pkg-1', 'agent-2', 'maintainer', 'agent-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('added_by'),
        expect.arrayContaining(['agent-1'])
      );
    });
  });

  describe('removeMaintainer', () => {
    it('should remove maintainer', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          package_id: 'pkg-1',
          agent_id: 'agent-1'
        }]
      });

      const result = await service.removeMaintainer('pkg-1', 'agent-1');

      expect(result.agent_id).toBe('agent-1');
    });

    it('should return undefined for non-existent maintainer', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.removeMaintainer('pkg-1', 'agent-1');

      expect(result).toBeUndefined();
    });
  });

  describe('listMaintainers', () => {
    it('should list maintainers sorted by role', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { agent_id: 'a1', agent_name: 'Owner', role: 'owner' },
          { agent_id: 'a2', agent_name: 'Maintainer', role: 'maintainer' }
        ]
      });

      const result = await service.listMaintainers('pkg-1');

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('owner');
    });

    it('should return empty array for no maintainers', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.listMaintainers('pkg-1');

      expect(result).toEqual([]);
    });
  });

  describe('canPerform', () => {
    it('should allow publish for maintainer with permission', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          can_publish: true,
          can_yank: false
        }]
      });

      const result = await service.canPerform('agent-1', 'pkg-1', 'publish');

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('allowed');
    });

    it('should deny publish for maintainer without permission', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          can_publish: false
        }]
      });

      const result = await service.canPerform('agent-1', 'pkg-1', 'publish');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_publish_permission');
    });

    it('should deny for non-maintainer', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.canPerform('agent-1', 'pkg-1', 'publish');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not_maintainer');
    });

    it('should check yank permission', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ can_yank: true }]
      });

      const result = await service.canPerform('agent-1', 'pkg-1', 'yank');

      expect(result.allowed).toBe(true);
    });

    it('should check add_maintainer permission', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ can_add_maintainers: false }]
      });

      const result = await service.canPerform('agent-1', 'pkg-1', 'add_maintainer');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_maintainer_permission');
    });

    it('should check deprecate permission', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ can_deprecate: true }]
      });

      const result = await service.canPerform('agent-1', 'pkg-1', 'deprecate');

      expect(result.allowed).toBe(true);
    });

    it('should deny unknown actions', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ can_publish: true }]
      });

      const result = await service.canPerform('agent-1', 'pkg-1', 'delete');

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('unknown_action');
    });
  });

  // ============================================================
  // Security Advisories
  // ============================================================

  describe('createAdvisory', () => {
    it('should create a security advisory', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'adv-1',
          package_id: 'pkg-1',
          title: 'SQL Injection Vulnerability',
          severity: 'critical',
          affected_versions: '>=1.0.0 <1.2.0',
          status: 'open'
        }]
      });

      const result = await service.createAdvisory('pkg-1', {
        title: 'SQL Injection Vulnerability',
        description: 'A SQL injection vulnerability was found',
        severity: 'critical',
        affected_versions: '>=1.0.0 <1.2.0',
        patched_versions: '>=1.2.0',
        cve_id: 'CVE-2024-12345'
      }, 'agent-1');

      expect(result.severity).toBe('critical');
      expect(result.affected_versions).toBe('>=1.0.0 <1.2.0');
    });

    it('should handle advisory without CVE', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'adv-1',
          title: 'Minor Security Issue',
          severity: 'low'
        }]
      });

      const result = await service.createAdvisory('pkg-1', {
        title: 'Minor Security Issue',
        description: 'Description',
        severity: 'low',
        affected_versions: '<1.0.0'
      }, 'agent-1');

      expect(result.severity).toBe('low');
    });
  });

  describe('listAdvisories', () => {
    it('should list advisories sorted by severity', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'adv-1', severity: 'critical', title: 'Critical Issue' },
          { id: 'adv-2', severity: 'high', title: 'High Issue' },
          { id: 'adv-3', severity: 'medium', title: 'Medium Issue' }
        ]
      });

      const result = await service.listAdvisories('pkg-1');

      expect(result).toHaveLength(3);
      expect(result[0].severity).toBe('critical');
    });

    it('should return empty array for no advisories', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.listAdvisories('pkg-1');

      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // Helpers
  // ============================================================

  describe('calculateChecksum', () => {
    it('should calculate SHA256 checksum', () => {
      const content = 'test content';
      const checksum = service.calculateChecksum(content);

      expect(checksum).toBe('6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72');
    });

    it('should produce consistent results', () => {
      const content = 'consistent data';
      const checksum1 = service.calculateChecksum(content);
      const checksum2 = service.calculateChecksum(content);

      expect(checksum1).toBe(checksum2);
    });
  });

  describe('extractDependencies', () => {
    it('should extract npm-style dependencies', () => {
      const manifest = {
        dependencies: { 'lodash': '^4.0.0' },
        devDependencies: { 'vitest': '^1.0.0' },
        peerDependencies: { 'react': '>=18' }
      };

      const result = service.extractDependencies(manifest);

      expect(result.dependencies).toEqual({ 'lodash': '^4.0.0' });
      expect(result.devDependencies).toEqual({ 'vitest': '^1.0.0' });
      expect(result.peerDependencies).toEqual({ 'react': '>=18' });
    });

    it('should extract Python-style dependencies', () => {
      const manifest = {
        requires: ['requests>=2.0', 'flask'],
        dev_requires: ['pytest']
      };

      const result = service.extractDependencies(manifest);

      expect(result.dependencies).toEqual(['requests>=2.0', 'flask']);
      expect(result.devDependencies).toEqual(['pytest']);
    });

    it('should handle empty manifest', () => {
      const result = service.extractDependencies({});

      expect(result.dependencies).toEqual({});
      expect(result.devDependencies).toEqual({});
      expect(result.peerDependencies).toEqual({});
    });
  });

  describe('storeArtifact', () => {
    it('should return local storage URL by default', async () => {
      const url = await service.storeArtifact('pkg-1', '1.0.0', {
        filename: 'package.tar.gz'
      });

      expect(url).toBe('/packages/pkg-1/1.0.0/package.tar.gz');
    });

    it('should use default filename if not provided', async () => {
      const url = await service.storeArtifact('pkg-1', '1.0.0', {});

      expect(url).toBe('/packages/pkg-1/1.0.0/package.tar.gz');
    });

    it('should return S3 URL when configured', async () => {
      service.storageType = 's3';
      service.storageBucket = 'my-bucket';

      const url = await service.storeArtifact('pkg-1', '1.0.0', {
        filename: 'package.tar.gz'
      });

      expect(url).toBe('https://my-bucket.s3.amazonaws.com/pkg-1/1.0.0/package.tar.gz');
    });

    it('should return GCS URL when configured', async () => {
      service.storageType = 'gcs';
      service.storageBucket = 'my-bucket';

      const url = await service.storeArtifact('pkg-1', '1.0.0', {
        filename: 'package.tar.gz'
      });

      expect(url).toBe('https://storage.googleapis.com/my-bucket/pkg-1/1.0.0/package.tar.gz');
    });
  });
});
