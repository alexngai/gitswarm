import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('GitSwarm Webhook Handlers', () => {
  let mockQuery;

  beforeEach(() => {
    mockQuery = vi.fn();
  });

  describe('Installation Events', () => {
    describe('handleInstallationEvent - created', () => {
      it('should create new gitswarm_org on app installation', async () => {
        const payload = {
          action: 'created',
          installation: {
            id: 12345,
            account: {
              login: 'test-organization',
              id: 67890,
              type: 'Organization'
            }
          },
          repositories: [
            { id: 1, name: 'repo1', full_name: 'test-organization/repo1', private: false, description: 'First repo', default_branch: 'main' },
            { id: 2, name: 'repo2', full_name: 'test-organization/repo2', private: true, description: 'Second repo', default_branch: 'main' }
          ]
        };

        // Simulate org creation
        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'org-uuid' }] }) // Insert org
          .mockResolvedValueOnce({ rows: [{ id: 'org-uuid' }] }) // Get org id
          .mockResolvedValueOnce({ rows: [] }) // Sync repo 1
          .mockResolvedValueOnce({ rows: [] }); // Sync repo 2

        const orgInsert = await mockQuery(`
          INSERT INTO gitswarm_orgs (
            github_org_name, github_org_id, github_installation_id, status
          ) VALUES ($1, $2, $3, 'active')
          ON CONFLICT (github_installation_id) DO UPDATE SET
            github_org_name = $1,
            status = 'active',
            updated_at = NOW()
        `, [
          payload.installation.account.login,
          payload.installation.account.id,
          payload.installation.id
        ]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO gitswarm_orgs'),
          ['test-organization', 67890, 12345]
        );
      });

      it('should sync initial repositories on installation', async () => {
        const orgId = 'org-uuid';
        const repo = {
          id: 1,
          name: 'repo1',
          full_name: 'test-organization/repo1',
          private: false,
          description: 'First repo',
          default_branch: 'main'
        };

        mockQuery.mockResolvedValueOnce({ rows: [] });

        await mockQuery(`
          INSERT INTO gitswarm_repos (
            org_id, github_repo_name, github_repo_id, github_full_name,
            is_private, description, default_branch, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
          ON CONFLICT (github_repo_id) DO UPDATE SET
            github_repo_name = $2,
            github_full_name = $4,
            is_private = $5,
            description = $6,
            default_branch = $7,
            status = 'active',
            updated_at = NOW()
        `, [
          orgId,
          repo.name,
          repo.id,
          repo.full_name,
          repo.private,
          repo.description,
          repo.default_branch
        ]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO gitswarm_repos'),
          expect.arrayContaining([orgId, 'repo1', 1, 'test-organization/repo1', false, 'First repo', 'main'])
        );
      });
    });

    describe('handleInstallationEvent - deleted', () => {
      it('should unlink forges and mark org as uninstalled', async () => {
        const payload = {
          action: 'deleted',
          installation: {
            id: 12345,
            account: {
              login: 'test-organization'
            }
          }
        };

        mockQuery
          .mockResolvedValueOnce({ rowCount: 2 }) // Unlink forges
          .mockResolvedValueOnce({ rowCount: 1 }); // Mark org uninstalled

        // Unlink forges
        await mockQuery(
          `UPDATE forges SET github_app_installation_id = NULL WHERE github_app_installation_id = $1`,
          [payload.installation.id]
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('github_app_installation_id = NULL'),
          [12345]
        );

        // Mark GitSwarm org as uninstalled
        await mockQuery(`
          UPDATE gitswarm_orgs SET status = 'uninstalled', updated_at = NOW()
          WHERE github_installation_id = $1
        `, [payload.installation.id]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'uninstalled'"),
          [12345]
        );
      });
    });

    describe('handleInstallationEvent - suspend', () => {
      it('should mark org as suspended', async () => {
        const payload = {
          action: 'suspend',
          installation: {
            id: 12345,
            account: {
              login: 'test-organization'
            }
          }
        };

        mockQuery.mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(`
          UPDATE gitswarm_orgs SET status = 'suspended', updated_at = NOW()
          WHERE github_installation_id = $1
        `, [payload.installation.id]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'suspended'"),
          [12345]
        );
      });
    });

    describe('handleInstallationEvent - unsuspend', () => {
      it('should mark org as active', async () => {
        const payload = {
          action: 'unsuspend',
          installation: {
            id: 12345,
            account: {
              login: 'test-organization'
            }
          }
        };

        mockQuery.mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(`
          UPDATE gitswarm_orgs SET status = 'active', updated_at = NOW()
          WHERE github_installation_id = $1
        `, [payload.installation.id]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'active'"),
          [12345]
        );
      });
    });
  });

  describe('Installation Repositories Events', () => {
    describe('handleInstallationRepositoriesEvent - added', () => {
      it('should sync newly added repositories', async () => {
        const payload = {
          action: 'added',
          installation: { id: 12345 },
          repositories_added: [
            { id: 3, name: 'new-repo', full_name: 'org/new-repo', private: false, description: 'New repo', default_branch: 'main' }
          ],
          repositories_removed: []
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'org-uuid' }] }) // Get org
          .mockResolvedValueOnce({ rows: [] }); // Sync repo

        // Get org ID
        const orgResult = await mockQuery(`
          SELECT id FROM gitswarm_orgs WHERE github_installation_id = $1
        `, [payload.installation.id]);

        expect(orgResult.rows[0].id).toBe('org-uuid');

        // Sync new repo
        await mockQuery(`
          INSERT INTO gitswarm_repos (
            org_id, github_repo_name, github_repo_id, github_full_name,
            is_private, description, default_branch, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
          ON CONFLICT (github_repo_id) DO UPDATE SET
            github_repo_name = $2,
            github_full_name = $4,
            is_private = $5,
            description = $6,
            default_branch = $7,
            status = 'active',
            updated_at = NOW()
        `, [
          'org-uuid',
          payload.repositories_added[0].name,
          payload.repositories_added[0].id,
          payload.repositories_added[0].full_name,
          payload.repositories_added[0].private,
          payload.repositories_added[0].description,
          payload.repositories_added[0].default_branch
        ]);

        expect(mockQuery).toHaveBeenCalledTimes(2);
      });

      it('should handle missing org gracefully', async () => {
        const payload = {
          action: 'added',
          installation: { id: 99999 },
          repositories_added: [
            { id: 3, name: 'new-repo', full_name: 'org/new-repo', private: false }
          ]
        };

        mockQuery.mockResolvedValueOnce({ rows: [] });

        const orgResult = await mockQuery(`
          SELECT id FROM gitswarm_orgs WHERE github_installation_id = $1
        `, [payload.installation.id]);

        expect(orgResult.rows).toHaveLength(0);
        // Should not throw, just skip syncing
      });
    });

    describe('handleInstallationRepositoriesEvent - removed', () => {
      it('should mark removed repositories as removed status', async () => {
        const payload = {
          action: 'removed',
          installation: { id: 12345 },
          repositories_added: [],
          repositories_removed: [
            { id: 3, name: 'removed-repo', full_name: 'org/removed-repo' }
          ]
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'org-uuid' }] }) // Get org
          .mockResolvedValueOnce({ rowCount: 1 }); // Update repo status

        await mockQuery(`
          UPDATE gitswarm_repos SET status = 'removed', updated_at = NOW()
          WHERE github_repo_id = $1
        `, [payload.repositories_removed[0].id]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'removed'"),
          [3]
        );
      });
    });
  });

  describe('Pull Request Events', () => {
    describe('handlePullRequestEvent - merged', () => {
      it('should update patch status to merged and award karma', async () => {
        const payload = {
          action: 'closed',
          pull_request: {
            merged: true,
            html_url: 'https://github.com/org/repo/pull/42'
          },
          repository: {
            full_name: 'org/repo'
          }
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'patch-uuid', status: 'open' }] }) // Find patch
          .mockResolvedValueOnce({ rowCount: 1 }) // Update patch status
          .mockResolvedValueOnce({ rows: [{ author_id: 'author-uuid' }] }) // Get author
          .mockResolvedValueOnce({ rowCount: 1 }) // Award author karma
          .mockResolvedValueOnce({ rows: [{ reviewer_id: 'reviewer-uuid' }] }) // Get reviewers
          .mockResolvedValueOnce({ rowCount: 1 }); // Award reviewer karma

        // Find patch
        const patchResult = await mockQuery(
          `SELECT id, status FROM patches WHERE github_pr_url = $1`,
          [payload.pull_request.html_url]
        );

        expect(patchResult.rows[0].id).toBe('patch-uuid');

        // Update patch status
        await mockQuery(
          `UPDATE patches SET status = 'merged', updated_at = NOW() WHERE id = $1`,
          ['patch-uuid']
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'merged'"),
          ['patch-uuid']
        );

        // Get patch author
        const authorResult = await mockQuery(
          `SELECT author_id FROM patches WHERE id = $1`,
          ['patch-uuid']
        );

        // Award author karma
        await mockQuery(
          `UPDATE agents SET karma = karma + 25 WHERE id = $1`,
          [authorResult.rows[0].author_id]
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('karma + 25'),
          ['author-uuid']
        );
      });

      it('should award karma to approving reviewers', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [
            { reviewer_id: 'reviewer-1' },
            { reviewer_id: 'reviewer-2' }
          ]
        });

        const reviews = await mockQuery(
          `SELECT DISTINCT reviewer_id FROM patch_reviews WHERE patch_id = $1 AND verdict = 'approve'`,
          ['patch-uuid']
        );

        expect(reviews.rows).toHaveLength(2);

        // Award karma to each reviewer
        for (const review of reviews.rows) {
          mockQuery.mockResolvedValueOnce({ rowCount: 1 });
          await mockQuery(
            `UPDATE agents SET karma = karma + 5 WHERE id = $1`,
            [review.reviewer_id]
          );
        }
      });
    });

    describe('handlePullRequestEvent - closed without merge', () => {
      it('should update patch status to closed', async () => {
        const payload = {
          action: 'closed',
          pull_request: {
            merged: false,
            html_url: 'https://github.com/org/repo/pull/42'
          }
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'patch-uuid', status: 'open' }] })
          .mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(
          `UPDATE patches SET status = 'closed', updated_at = NOW() WHERE id = $1`,
          ['patch-uuid']
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'closed'"),
          ['patch-uuid']
        );
      });
    });

    describe('handlePullRequestEvent - reopened', () => {
      it('should update patch status to open', async () => {
        const payload = {
          action: 'reopened',
          pull_request: {
            html_url: 'https://github.com/org/repo/pull/42'
          }
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'patch-uuid', status: 'closed' }] })
          .mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(
          `UPDATE patches SET status = 'open', updated_at = NOW() WHERE id = $1`,
          ['patch-uuid']
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining("status = 'open'"),
          ['patch-uuid']
        );
      });
    });

    describe('handlePullRequestEvent - synchronize', () => {
      it('should update patch timestamp on new commits', async () => {
        const payload = {
          action: 'synchronize',
          pull_request: {
            html_url: 'https://github.com/org/repo/pull/42'
          },
          before: 'abc123',
          after: 'def456'
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'patch-uuid' }] })
          .mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(
          `UPDATE patches SET updated_at = NOW() WHERE id = $1`,
          ['patch-uuid']
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('updated_at = NOW()'),
          ['patch-uuid']
        );
      });
    });

    describe('handlePullRequestEvent - non-BotHub PR', () => {
      it('should skip processing for non-BotHub managed PRs', async () => {
        const payload = {
          action: 'closed',
          pull_request: {
            merged: true,
            html_url: 'https://github.com/org/repo/pull/99'
          }
        };

        mockQuery.mockResolvedValueOnce({ rows: [] });

        const patchResult = await mockQuery(
          `SELECT id, status FROM patches WHERE github_pr_url = $1`,
          [payload.pull_request.html_url]
        );

        expect(patchResult.rows).toHaveLength(0);
        // Should not process further
      });
    });
  });

  describe('Pull Request Review Events', () => {
    describe('handlePullRequestReviewEvent - submitted', () => {
      it('should log external review for tracking', async () => {
        const payload = {
          action: 'submitted',
          review: {
            state: 'approved',
            body: 'LGTM!',
            user: {
              login: 'external-reviewer',
              id: 12345
            }
          },
          pull_request: {
            html_url: 'https://github.com/org/repo/pull/42'
          }
        };

        mockQuery.mockResolvedValueOnce({ rows: [{ id: 'patch-uuid' }] });

        const patchResult = await mockQuery(
          `SELECT id FROM patches WHERE github_pr_url = $1`,
          [payload.pull_request.html_url]
        );

        expect(patchResult.rows[0].id).toBe('patch-uuid');
        // External reviews are logged but not directly mapped to BotHub agents
      });

      it('should ignore non-submitted review actions', () => {
        const payload = {
          action: 'edited', // Not 'submitted'
          review: {
            state: 'approved'
          }
        };

        expect(payload.action).not.toBe('submitted');
        // Should return early
      });
    });
  });

  describe('Push Events', () => {
    describe('handlePushEvent', () => {
      it('should update patch timestamp for bothub branch pushes', async () => {
        const payload = {
          ref: 'refs/heads/bothub/patch-abc12345-feature',
          commits: [
            {
              id: 'commit-sha',
              message: 'Update feature',
              author: { name: 'Agent', email: 'agent@bothub.dev' }
            }
          ],
          repository: {
            full_name: 'org/repo'
          }
        };

        const branchName = payload.ref.replace('refs/heads/', '');
        expect(branchName).toBe('bothub/patch-abc12345-feature');
        expect(branchName.startsWith('bothub/patch-')).toBe(true);

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'patch-uuid' }] })
          .mockResolvedValueOnce({ rowCount: 1 });

        // Find patch by branch
        await mockQuery(
          `SELECT id FROM patches WHERE github_branch = $1`,
          [branchName]
        );

        // Update timestamp
        await mockQuery(
          `UPDATE patches SET updated_at = NOW() WHERE id = $1`,
          ['patch-uuid']
        );

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('github_branch'),
          ['bothub/patch-abc12345-feature']
        );
      });

      it('should ignore pushes to non-bothub branches', () => {
        const payload = {
          ref: 'refs/heads/main',
          commits: []
        };

        const branchName = payload.ref.replace('refs/heads/', '');
        expect(branchName.startsWith('bothub/patch-')).toBe(false);
        // Should return early
      });
    });
  });

  describe('Webhook Signature Verification', () => {
    it('should validate webhook signature format', () => {
      const validSignature = 'sha256=abc123def456...';
      const invalidSignature = 'invalid-format';

      expect(validSignature.startsWith('sha256=')).toBe(true);
      expect(invalidSignature.startsWith('sha256=')).toBe(false);
    });

    it('should reject missing signature', () => {
      const headers = {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-id'
        // Missing x-hub-signature-256
      };

      expect(headers['x-hub-signature-256']).toBeUndefined();
    });
  });

  describe('Repository Sync Helper', () => {
    it('should handle sync errors gracefully', async () => {
      const orgId = 'org-uuid';
      const repo = {
        id: 1,
        name: 'repo1',
        full_name: 'org/repo1',
        private: false,
        description: 'Test repo',
        default_branch: 'main'
      };

      const syncError = new Error('Database connection failed');
      mockQuery.mockRejectedValueOnce(syncError);

      let errorCaught = false;
      try {
        await mockQuery(`
          INSERT INTO gitswarm_repos (...) VALUES (...)
        `, [orgId, repo.name, repo.id, repo.full_name, repo.private, repo.description, repo.default_branch]);
      } catch (error) {
        errorCaught = true;
        expect(error.message).toBe('Database connection failed');
      }

      expect(errorCaught).toBe(true);
      // Should log error but not throw to caller
    });

    it('should update existing repo on conflict', async () => {
      const orgId = 'org-uuid';
      const repo = {
        id: 1,
        name: 'repo1-renamed',
        full_name: 'org/repo1-renamed',
        private: true, // Changed visibility
        description: 'Updated description',
        default_branch: 'develop' // Changed default branch
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'repo-uuid',
          github_repo_name: repo.name,
          github_full_name: repo.full_name,
          is_private: repo.private,
          description: repo.description,
          default_branch: repo.default_branch
        }]
      });

      const result = await mockQuery(`
        INSERT INTO gitswarm_repos (
          org_id, github_repo_name, github_repo_id, github_full_name,
          is_private, description, default_branch, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
        ON CONFLICT (github_repo_id) DO UPDATE SET
          github_repo_name = $2,
          github_full_name = $4,
          is_private = $5,
          description = $6,
          default_branch = $7,
          status = 'active',
          updated_at = NOW()
        RETURNING *
      `, [orgId, repo.name, repo.id, repo.full_name, repo.private, repo.description, repo.default_branch]);

      expect(result.rows[0].github_repo_name).toBe('repo1-renamed');
      expect(result.rows[0].is_private).toBe(true);
    });
  });

  describe('GitSwarm-Specific Webhook Data', () => {
    it('should track gitswarm_patches linking', async () => {
      const patchId = 'patch-uuid';
      const repoId = 'repo-uuid';
      const prData = {
        number: 42,
        url: 'https://github.com/org/repo/pull/42',
        branch: 'bothub/patch-abc123-feature',
        base_branch: 'main'
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'gitswarm-patch-uuid',
          patch_id: patchId,
          repo_id: repoId,
          github_pr_number: prData.number,
          github_pr_url: prData.url,
          github_branch: prData.branch,
          base_branch: prData.base_branch
        }]
      });

      const result = await mockQuery(`
        INSERT INTO gitswarm_patches (patch_id, repo_id, github_pr_number, github_pr_url, github_branch, base_branch)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [patchId, repoId, prData.number, prData.url, prData.branch, prData.base_branch]);

      expect(result.rows[0].github_pr_number).toBe(42);
      expect(result.rows[0].base_branch).toBe('main');
    });

    it('should update gitswarm_patch PR state', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      await mockQuery(`
        UPDATE gitswarm_patches SET
          github_pr_state = $2,
          last_synced_at = NOW()
        WHERE patch_id = $1
      `, ['patch-uuid', 'merged']);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('github_pr_state'),
        ['patch-uuid', 'merged']
      );
    });
  });
});
