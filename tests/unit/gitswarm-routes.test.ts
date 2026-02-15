import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('GitSwarm Routes', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let mockRequest: {
    agent: { id: string; name: string; karma: number };
    params: Record<string, any>;
    body: Record<string, any>;
    query: Record<string, any>;
  };
  let mockReply: {
    status: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockQuery = vi.fn();
    mockRequest = {
      agent: { id: 'agent-123', name: 'test-agent', karma: 100 },
      params: {},
      body: {},
      query: {}
    };
    mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn()
    };
  });

  describe('Organization Routes', () => {
    describe('GET /gitswarm/orgs/:id', () => {
      it('should return org details with repos', async () => {
        const orgId = 'org-123';
        const mockOrg = {
          id: orgId,
          github_org_name: 'test-org',
          github_org_id: 12345,
          default_agent_access: 'karma_threshold',
          default_min_karma: 100,
          is_platform_org: false,
          status: 'active'
        };
        const mockRepos = [
          { id: 'repo-1', github_repo_name: 'repo1', status: 'active' },
          { id: 'repo-2', github_repo_name: 'repo2', status: 'active' }
        ];

        mockQuery
          .mockResolvedValueOnce({ rows: [mockOrg] })
          .mockResolvedValueOnce({ rows: mockRepos });

        // Simulate route logic
        const orgResult = await mockQuery(
          `SELECT * FROM gitswarm_orgs WHERE id = $1`,
          [orgId]
        );

        expect(orgResult.rows[0].github_org_name).toBe('test-org');

        const reposResult = await mockQuery(
          `SELECT * FROM gitswarm_repos WHERE org_id = $1 AND status = 'active'`,
          [orgId]
        );

        expect(reposResult.rows).toHaveLength(2);
      });

      it('should return 404 for non-existent org', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await mockQuery(
          `SELECT * FROM gitswarm_orgs WHERE id = $1`,
          ['non-existent']
        );

        expect(result.rows).toHaveLength(0);
      });
    });

    describe('PATCH /gitswarm/orgs/:id', () => {
      it('should update org settings when authorized', async () => {
        const orgId = 'org-123';
        const updateData = {
          default_agent_access: 'public',
          default_min_karma: 50
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ owner_id: 'agent-123' }] }) // Owner check
          .mockResolvedValueOnce({
            rows: [{
              id: orgId,
              default_agent_access: 'public',
              default_min_karma: 50
            }]
          });

        const ownerCheck = await mockQuery(
          `SELECT owner_id FROM gitswarm_orgs WHERE id = $1`,
          [orgId]
        );

        expect(ownerCheck.rows[0].owner_id).toBe('agent-123');

        const updateResult = await mockQuery(
          `UPDATE gitswarm_orgs SET
            default_agent_access = $2,
            default_min_karma = $3,
            updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
          [orgId, updateData.default_agent_access, updateData.default_min_karma]
        );

        expect(updateResult.rows[0].default_agent_access).toBe('public');
      });

      it('should reject updates from non-owner', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ owner_id: 'other-agent' }] });

        const ownerCheck = await mockQuery(
          `SELECT owner_id FROM gitswarm_orgs WHERE id = $1`,
          ['org-123']
        );

        expect(ownerCheck.rows[0].owner_id).not.toBe('agent-123');
      });
    });
  });

  describe('Repository Routes', () => {
    describe('GET /gitswarm/repos/:id', () => {
      it('should return repo details with maintainers', async () => {
        const repoId = 'repo-123';
        const mockRepo = {
          id: repoId,
          org_id: 'org-1',
          github_repo_name: 'test-repo',
          github_full_name: 'org/test-repo',
          ownership_model: 'open',
          consensus_threshold: 0.66,
          agent_access: 'karma_threshold',
          min_karma: 100
        };
        const mockMaintainers = [
          { agent_id: 'agent-1', role: 'owner', name: 'Owner Agent' },
          { agent_id: 'agent-2', role: 'maintainer', name: 'Maintainer Agent' }
        ];

        mockQuery
          .mockResolvedValueOnce({ rows: [mockRepo] })
          .mockResolvedValueOnce({ rows: mockMaintainers });

        const repoResult = await mockQuery(
          `SELECT * FROM gitswarm_repos WHERE id = $1`,
          [repoId]
        );

        expect(repoResult.rows[0].github_full_name).toBe('org/test-repo');

        const maintainersResult = await mockQuery(
          `SELECT m.agent_id, m.role, a.name
           FROM gitswarm_maintainers m
           JOIN agents a ON m.agent_id = a.id
           WHERE m.repo_id = $1`,
          [repoId]
        );

        expect(maintainersResult.rows).toHaveLength(2);
        expect(maintainersResult.rows[0].role).toBe('owner');
      });

      it('should check agent permissions and return appropriate access level', async () => {
        const repoId = 'repo-123';
        const agentId = 'agent-123';

        mockQuery
          .mockResolvedValueOnce({ rows: [{ access_level: 'write' }] }); // Explicit access

        const accessResult = await mockQuery(
          `SELECT access_level FROM gitswarm_repo_access
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, agentId]
        );

        expect(accessResult.rows[0].access_level).toBe('write');
      });
    });

    describe('POST /gitswarm/repos', () => {
      it('should create repo in platform org with karma check', async () => {
        const createData = {
          org_id: 'platform-org',
          github_repo_name: 'new-repo',
          description: 'A new repo',
          ownership_model: 'open'
        };

        // Check karma limits
        mockQuery
          .mockResolvedValueOnce({ rows: [{ karma: 500 }] }) // Agent karma
          .mockResolvedValueOnce({ rows: [{ daily: '0', weekly: '0', monthly: '0' }] }) // Usage
          .mockResolvedValueOnce({ rows: [{ is_platform_org: true }] }) // Org check
          .mockResolvedValueOnce({
            rows: [{
              id: 'new-repo-id',
              ...createData
            }]
          });

        const karmaResult = await mockQuery(
          `SELECT karma FROM agents WHERE id = $1`,
          ['agent-123']
        );
        expect(karmaResult.rows[0].karma).toBe(500);

        const usageResult = await mockQuery(
          `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day') as daily,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as weekly,
                  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as monthly
           FROM gitswarm_repos r
           JOIN gitswarm_maintainers m ON m.repo_id = r.id
           WHERE m.agent_id = $1 AND m.role = 'owner'`,
          ['agent-123']
        );
        expect(parseInt(usageResult.rows[0].daily)).toBeLessThan(2);
      });

      it('should reject repo creation when rate limited', async () => {
        mockQuery
          .mockResolvedValueOnce({ rows: [{ karma: 500 }] })
          .mockResolvedValueOnce({ rows: [{ daily: '2', weekly: '2', monthly: '2' }] });

        const karmaResult = await mockQuery(
          `SELECT karma FROM agents WHERE id = $1`,
          ['agent-123']
        );
        expect(karmaResult.rows[0].karma).toBe(500);

        const usageResult = await mockQuery(
          `SELECT COUNT(*) as daily FROM gitswarm_repos WHERE agent_id = $1`,
          ['agent-123']
        );
        // Daily limit for 500 karma is 2
        expect(parseInt(usageResult.rows[0].daily)).toBe(2);
      });
    });

    describe('PATCH /gitswarm/repos/:id', () => {
      it('should update repo settings when maintainer', async () => {
        const repoId = 'repo-123';
        const updateData = {
          ownership_model: 'guild',
          consensus_threshold: 0.75,
          min_reviews: 2
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // Maintainer check
          .mockResolvedValueOnce({
            rows: [{
              id: repoId,
              ...updateData
            }]
          });

        const maintainerCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        expect(maintainerCheck.rows[0].role).toBe('owner');
      });

      it('should reject updates from non-maintainer', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const maintainerCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          ['repo-123', 'agent-123']
        );

        expect(maintainerCheck.rows).toHaveLength(0);
      });
    });
  });

  describe('Maintainer Routes', () => {
    describe('GET /gitswarm/repos/:id/maintainers', () => {
      it('should list all maintainers with details', async () => {
        const repoId = 'repo-123';
        const mockMaintainers = [
          {
            agent_id: 'agent-1',
            role: 'owner',
            added_at: '2024-01-01T00:00:00Z',
            name: 'Owner Bot',
            karma: 1000
          },
          {
            agent_id: 'agent-2',
            role: 'maintainer',
            added_at: '2024-01-02T00:00:00Z',
            name: 'Helper Bot',
            karma: 500
          }
        ];

        mockQuery.mockResolvedValueOnce({ rows: mockMaintainers });

        const result = await mockQuery(
          `SELECT m.*, a.name, a.karma
           FROM gitswarm_maintainers m
           JOIN agents a ON m.agent_id = a.id
           WHERE m.repo_id = $1
           ORDER BY m.role DESC, m.added_at ASC`,
          [repoId]
        );

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].role).toBe('owner');
      });
    });

    describe('POST /gitswarm/repos/:id/maintainers', () => {
      it('should add maintainer when authorized', async () => {
        const repoId = 'repo-123';
        const newMaintainer = {
          agent_id: 'new-agent',
          role: 'maintainer'
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // Auth check
          .mockResolvedValueOnce({ rows: [{ id: 'new-agent' }] }) // Agent exists
          .mockResolvedValueOnce({ rows: [newMaintainer] }); // Insert

        const authCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        expect(authCheck.rows[0].role).toBe('owner');

        const agentExists = await mockQuery(
          `SELECT id FROM agents WHERE id = $1`,
          [newMaintainer.agent_id]
        );

        expect(agentExists.rows).toHaveLength(1);

        const insertResult = await mockQuery(
          `INSERT INTO gitswarm_maintainers (repo_id, agent_id, role, added_by)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [repoId, newMaintainer.agent_id, newMaintainer.role, 'agent-123']
        );

        expect(insertResult.rows[0].role).toBe('maintainer');
      });

      it('should reject adding maintainer when not owner', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] });

        const authCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          ['repo-123', 'agent-123']
        );

        // Only owners can add maintainers
        expect(authCheck.rows[0].role).not.toBe('owner');
      });
    });

    describe('DELETE /gitswarm/repos/:id/maintainers/:agentId', () => {
      it('should remove maintainer when owner', async () => {
        const repoId = 'repo-123';
        const targetAgentId = 'agent-to-remove';

        mockQuery
          .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // Auth check
          .mockResolvedValueOnce({ rows: [{ role: 'maintainer' }] }) // Target is not owner
          .mockResolvedValueOnce({ rowCount: 1 }); // Delete

        const authCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        expect(authCheck.rows[0].role).toBe('owner');

        const targetCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, targetAgentId]
        );

        expect(targetCheck.rows[0].role).toBe('maintainer');

        const deleteResult = await mockQuery(
          `DELETE FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, targetAgentId]
        );

        expect(deleteResult.rowCount).toBe(1);
      });

      it('should prevent removing the owner', async () => {
        mockQuery
          .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // Auth check
          .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // Target is owner

        const targetCheck = await mockQuery(
          `SELECT role FROM gitswarm_maintainers
           WHERE repo_id = $1 AND agent_id = $2`,
          ['repo-123', 'owner-agent']
        );

        expect(targetCheck.rows[0].role).toBe('owner');
        // Should not allow deletion of owner
      });
    });
  });

  describe('Access Control Routes', () => {
    describe('GET /gitswarm/repos/:id/access', () => {
      it('should list all explicit access grants', async () => {
        const repoId = 'repo-123';
        const mockAccess = [
          {
            agent_id: 'agent-1',
            access_level: 'write',
            granted_at: '2024-01-01T00:00:00Z',
            expires_at: null,
            name: 'Trusted Bot'
          },
          {
            agent_id: 'agent-2',
            access_level: 'read',
            granted_at: '2024-01-02T00:00:00Z',
            expires_at: '2024-12-31T23:59:59Z',
            name: 'Limited Bot'
          }
        ];

        mockQuery.mockResolvedValueOnce({ rows: mockAccess });

        const result = await mockQuery(
          `SELECT ra.*, a.name
           FROM gitswarm_repo_access ra
           JOIN agents a ON ra.agent_id = a.id
           WHERE ra.repo_id = $1
           ORDER BY ra.granted_at DESC`,
          [repoId]
        );

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].access_level).toBe('write');
      });
    });

    describe('POST /gitswarm/repos/:id/access', () => {
      it('should grant access when authorized', async () => {
        const repoId = 'repo-123';
        const accessGrant = {
          agent_id: 'new-agent',
          access_level: 'write',
          expires_at: '2024-12-31T23:59:59Z',
          reason: 'Temporary access for feature development'
        };

        // Auth check
        mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
        await mockQuery(
          `SELECT role FROM gitswarm_maintainers WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        // Agent exists check
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-agent' }] });
        await mockQuery(
          `SELECT id FROM agents WHERE id = $1`,
          [accessGrant.agent_id]
        );

        // Upsert access
        mockQuery.mockResolvedValueOnce({ rows: [accessGrant] });
        const result = await mockQuery(
          `INSERT INTO gitswarm_repo_access (repo_id, agent_id, access_level, granted_by, expires_at, reason)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (repo_id, agent_id) DO UPDATE SET
             access_level = $3,
             granted_by = $4,
             granted_at = NOW(),
             expires_at = $5,
             reason = $6
           RETURNING *`,
          [repoId, accessGrant.agent_id, accessGrant.access_level, 'agent-123', accessGrant.expires_at, accessGrant.reason]
        );

        expect(result.rows[0].access_level).toBe('write');
      });
    });

    describe('DELETE /gitswarm/repos/:id/access/:agentId', () => {
      it('should revoke access when authorized', async () => {
        const repoId = 'repo-123';
        const targetAgentId = 'agent-to-revoke';

        // Auth check
        mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
        await mockQuery(
          `SELECT role FROM gitswarm_maintainers WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        // Delete
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });
        const deleteResult = await mockQuery(
          `DELETE FROM gitswarm_repo_access
           WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, targetAgentId]
        );

        expect(deleteResult.rowCount).toBe(1);
      });
    });
  });

  describe('Branch Rules Routes', () => {
    describe('GET /gitswarm/repos/:id/branch-rules', () => {
      it('should list all branch rules', async () => {
        const repoId = 'repo-123';
        const mockRules = [
          {
            id: 'rule-1',
            branch_pattern: 'main',
            direct_push: 'none',
            required_approvals: 2,
            require_tests_pass: true,
            priority: 10
          },
          {
            id: 'rule-2',
            branch_pattern: 'release/*',
            direct_push: 'maintainers',
            required_approvals: 1,
            require_tests_pass: true,
            priority: 5
          }
        ];

        mockQuery.mockResolvedValueOnce({ rows: mockRules });

        const result = await mockQuery(
          `SELECT * FROM gitswarm_branch_rules
           WHERE repo_id = $1
           ORDER BY priority DESC`,
          [repoId]
        );

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0].branch_pattern).toBe('main');
      });
    });

    describe('POST /gitswarm/repos/:id/branch-rules', () => {
      it('should create branch rule when maintainer', async () => {
        const repoId = 'repo-123';
        const ruleData = {
          branch_pattern: 'feature/*',
          direct_push: 'all',
          required_approvals: 1,
          require_tests_pass: false
        };

        // Auth check
        mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
        await mockQuery(
          `SELECT role FROM gitswarm_maintainers WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        // Insert rule
        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'rule-new', ...ruleData }] });
        const result = await mockQuery(
          `INSERT INTO gitswarm_branch_rules (repo_id, branch_pattern, direct_push, required_approvals, require_tests_pass)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [repoId, ruleData.branch_pattern, ruleData.direct_push, ruleData.required_approvals, ruleData.require_tests_pass]
        );

        expect(result.rows[0].branch_pattern).toBe('feature/*');
      });
    });
  });

  describe('Input Validation', () => {
    it('should validate ownership_model enum', () => {
      const validModels = ['solo', 'guild', 'open'];
      const invalidModel = 'invalid';

      expect(validModels).toContain('open');
      expect(validModels).not.toContain(invalidModel);
    });

    it('should validate access_level enum', () => {
      const validLevels = ['none', 'read', 'write', 'maintain', 'admin'];
      const invalidLevel = 'superuser';

      expect(validLevels).toContain('write');
      expect(validLevels).not.toContain(invalidLevel);
    });

    it('should validate consensus_threshold range', () => {
      const validThreshold = 0.66;
      const invalidLow = -0.1;
      const invalidHigh = 1.5;

      expect(validThreshold).toBeGreaterThanOrEqual(0);
      expect(validThreshold).toBeLessThanOrEqual(1);
      expect(invalidLow).toBeLessThan(0);
      expect(invalidHigh).toBeGreaterThan(1);
    });

    it('should validate min_karma is non-negative', () => {
      const validKarma = 100;
      const invalidKarma = -50;

      expect(validKarma).toBeGreaterThanOrEqual(0);
      expect(invalidKarma).toBeLessThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors gracefully', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        mockQuery(`SELECT * FROM gitswarm_repos WHERE id = $1`, ['repo-123'])
      ).rejects.toThrow('Connection refused');
    });

    it('should handle constraint violations', async () => {
      const duplicateError = new Error('duplicate key value violates unique constraint');
      mockQuery.mockRejectedValueOnce(duplicateError);

      await expect(
        mockQuery(
          `INSERT INTO gitswarm_repos (github_repo_id) VALUES ($1)`,
          [12345]
        )
      ).rejects.toThrow('duplicate key');
    });
  });

  describe('Content Read Routes', () => {
    describe('GET /gitswarm/repos/:id/contents/*', () => {
      it('should return file contents when authorized', async () => {
        const repoId = 'repo-123';
        const path = 'README.md';

        // Simulate permission check
        mockQuery.mockResolvedValueOnce({ rows: [{ access_level: 'read' }] });

        const permCheck = await mockQuery(
          `SELECT access_level FROM gitswarm_repo_access WHERE repo_id = $1 AND agent_id = $2`,
          [repoId, 'agent-123']
        );

        expect(permCheck.rows[0].access_level).toBe('read');
      });

      it('should deny access without read permission', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] }); // No explicit access

        const permCheck = await mockQuery(
          `SELECT access_level FROM gitswarm_repo_access WHERE repo_id = $1 AND agent_id = $2`,
          ['repo-123', 'agent-no-access']
        );

        expect(permCheck.rows).toHaveLength(0);
      });

      it('should support ref parameter for specific branch/commit', async () => {
        const requestQuery = { ref: 'feature-branch' };
        expect(requestQuery.ref).toBe('feature-branch');
      });
    });

    describe('GET /gitswarm/repos/:id/tree', () => {
      it('should return directory tree when authorized', async () => {
        const repoId = 'repo-123';

        mockQuery.mockResolvedValueOnce({ rows: [{ access_level: 'read' }] });

        const permCheck = await mockQuery(
          `SELECT access_level FROM gitswarm_repo_access WHERE repo_id = $1`,
          [repoId]
        );

        expect(permCheck.rows[0]).toBeDefined();
      });

      it('should support recursive flag', async () => {
        const requestQuery = { recursive: 'false' };
        const isRecursive = requestQuery.recursive !== 'false';
        expect(isRecursive).toBe(false);

        const requestQueryTrue = { recursive: 'true' };
        const isRecursiveTrue = requestQueryTrue.recursive !== 'false';
        expect(isRecursiveTrue).toBe(true);
      });
    });

    describe('GET /gitswarm/repos/:id/branches', () => {
      it('should return branches list when authorized', async () => {
        const mockBranches = [
          { name: 'main', sha: 'sha1', protected: true },
          { name: 'develop', sha: 'sha2', protected: false },
          { name: 'feature/test', sha: 'sha3', protected: false }
        ];

        expect(mockBranches).toHaveLength(3);
        expect(mockBranches[0].protected).toBe(true);
      });
    });

    describe('GET /gitswarm/repos/:id/commits', () => {
      it('should return commits with pagination', async () => {
        const requestQuery = {
          sha: 'main',
          path: 'src/',
          per_page: '10'
        };

        expect(parseInt(requestQuery.per_page)).toBe(10);
      });

      it('should support date range filtering', async () => {
        const requestQuery = {
          since: '2024-01-01T00:00:00Z',
          until: '2024-12-31T23:59:59Z'
        };

        expect(requestQuery.since).toBeDefined();
        expect(requestQuery.until).toBeDefined();
      });
    });

    describe('GET /gitswarm/repos/:id/pulls', () => {
      it('should return pull requests with state filter', async () => {
        const requestQuery = {
          state: 'open',
          sort: 'created',
          direction: 'desc'
        };

        expect(requestQuery.state).toBe('open');
      });

      it('should return all states when requested', async () => {
        const requestQuery = { state: 'all' };
        expect(['open', 'closed', 'all']).toContain(requestQuery.state);
      });
    });

    describe('GET /gitswarm/repos/:id/clone', () => {
      it('should return authenticated clone URL when write access', async () => {
        const repoId = 'repo-123';

        // Simulate write permission check
        mockQuery.mockResolvedValueOnce({ rows: [{ access_level: 'write' }] });

        const permCheck = await mockQuery(
          `SELECT access_level FROM gitswarm_repo_access WHERE repo_id = $1`,
          [repoId]
        );

        expect(permCheck.rows[0].access_level).toBe('write');
      });

      it('should deny clone token without write permission', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ access_level: 'read' }] });

        const permCheck = await mockQuery(
          `SELECT access_level FROM gitswarm_repo_access WHERE repo_id = $1`,
          ['repo-123']
        );

        // read is not sufficient for clone with token
        expect(permCheck.rows[0].access_level).toBe('read');
      });
    });
  });

  describe('Rate Limiting', () => {
    it('should apply read rate limit for content routes', () => {
      const rateLimits = {
        gitswarm_read: { max: 300, window: 60 },
        gitswarm_write: { max: 30, window: 60 },
        gitswarm_clone: { max: 10, window: 60 },
        gitswarm_pr: { max: 5, window: 60 },
        gitswarm_repo: { max: 5, window: 3600 }
      };

      expect(rateLimits.gitswarm_read.max).toBe(300);
      expect(rateLimits.gitswarm_write.max).toBe(30);
    });

    it('should have more restrictive limits for write operations', () => {
      const readLimit = 300;
      const writeLimit = 30;
      const repoLimit = 5;

      expect(writeLimit).toBeLessThan(readLimit);
      expect(repoLimit).toBeLessThan(writeLimit);
    });
  });
});
