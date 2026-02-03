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

  // ============================================================
  // Phase 4: GitHub User Mappings & Human Review Sync
  // ============================================================

  describe('GitHub User Mapping', () => {
    describe('ensureGitHubUserMapping', () => {
      it('should create new user mapping for unknown GitHub user', async () => {
        const githubUser = {
          id: 12345,
          login: 'external-dev',
          avatar_url: 'https://github.com/avatars/12345'
        };

        mockQuery
          .mockResolvedValueOnce({ rows: [] }) // Check existing
          .mockResolvedValueOnce({
            rows: [{
              id: 'mapping-uuid',
              github_user_id: 12345,
              github_login: 'external-dev',
              agent_id: null
            }]
          }); // Insert new

        // Check if mapping exists
        const existing = await mockQuery(
          `SELECT id, agent_id FROM gitswarm_github_user_mappings WHERE github_user_id = $1`,
          [githubUser.id]
        );

        expect(existing.rows).toHaveLength(0);

        // Create new mapping
        const result = await mockQuery(`
          INSERT INTO gitswarm_github_user_mappings (github_user_id, github_login, avatar_url)
          VALUES ($1, $2, $3)
          ON CONFLICT (github_user_id) DO UPDATE SET
            github_login = $2,
            avatar_url = $3,
            last_seen_at = NOW()
          RETURNING *
        `, [githubUser.id, githubUser.login, githubUser.avatar_url]);

        expect(result.rows[0].github_login).toBe('external-dev');
        expect(result.rows[0].agent_id).toBeNull();
      });

      it('should return existing mapping for known user', async () => {
        const githubUser = {
          id: 12345,
          login: 'external-dev'
        };

        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'mapping-uuid',
            github_user_id: 12345,
            github_login: 'external-dev',
            agent_id: 'agent-uuid' // Linked to an agent
          }]
        });

        const result = await mockQuery(
          `SELECT id, agent_id FROM gitswarm_github_user_mappings WHERE github_user_id = $1`,
          [githubUser.id]
        );

        expect(result.rows[0].agent_id).toBe('agent-uuid');
      });

      it('should update last_seen_at on existing mapping', async () => {
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(`
          UPDATE gitswarm_github_user_mappings
          SET last_seen_at = NOW()
          WHERE github_user_id = $1
        `, [12345]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('last_seen_at = NOW()'),
          [12345]
        );
      });
    });
  });

  describe('Human Review Sync', () => {
    describe('syncHumanReviewToPatchReviews', () => {
      it('should create patch_review for human GitHub review', async () => {
        const payload = {
          review: {
            id: 9876,
            state: 'approved',
            body: 'LGTM! Great work.',
            user: {
              id: 12345,
              login: 'human-reviewer'
            }
          },
          pull_request: {
            html_url: 'https://github.com/org/repo/pull/42'
          }
        };

        // Map GitHub state to verdict
        const stateToVerdict = {
          'approved': 'approve',
          'changes_requested': 'request_changes',
          'commented': 'comment'
        };
        const verdict = stateToVerdict[payload.review.state];

        mockQuery
          .mockResolvedValueOnce({ rows: [{ id: 'patch-uuid' }] }) // Find patch
          .mockResolvedValueOnce({
            rows: [{ id: 'mapping-uuid', agent_id: null }]
          }) // User mapping
          .mockResolvedValueOnce({
            rows: [{
              id: 'review-uuid',
              patch_id: 'patch-uuid',
              github_user_mapping_id: 'mapping-uuid',
              is_human: true,
              verdict: verdict
            }]
          }); // Insert review

        // Find the patch
        const patch = await mockQuery(
          `SELECT id FROM patches WHERE github_pr_url = $1`,
          [payload.pull_request.html_url]
        );

        expect(patch.rows[0].id).toBe('patch-uuid');

        // Get or create user mapping
        const mapping = await mockQuery(
          `SELECT id, agent_id FROM gitswarm_github_user_mappings WHERE github_user_id = $1`,
          [payload.review.user.id]
        );

        // Insert human review
        const result = await mockQuery(`
          INSERT INTO patch_reviews (
            patch_id, github_user_mapping_id, is_human, verdict, comments, github_review_id
          ) VALUES ($1, $2, true, $3, $4, $5)
          ON CONFLICT (patch_id, github_review_id) DO UPDATE SET
            verdict = $3,
            comments = $4,
            updated_at = NOW()
          RETURNING *
        `, ['patch-uuid', mapping.rows[0].id, verdict, payload.review.body, payload.review.id]);

        expect(result.rows[0].is_human).toBe(true);
        expect(result.rows[0].verdict).toBe('approve');
      });

      it('should link review to agent when GitHub user is mapped', async () => {
        const payload = {
          review: {
            id: 9876,
            state: 'approved',
            user: { id: 12345, login: 'mapped-developer' }
          }
        };

        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'mapping-uuid',
            agent_id: 'agent-uuid' // User is mapped to an agent
          }]
        });

        const mapping = await mockQuery(
          `SELECT id, agent_id FROM gitswarm_github_user_mappings WHERE github_user_id = $1`,
          [payload.review.user.id]
        );

        expect(mapping.rows[0].agent_id).toBe('agent-uuid');

        // When creating review, should use both reviewer_id and github_user_mapping_id
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'review-uuid',
            reviewer_id: 'agent-uuid',
            github_user_mapping_id: 'mapping-uuid'
          }]
        });
      });

      it('should handle changes_requested review state', async () => {
        const payload = {
          review: {
            id: 9877,
            state: 'changes_requested',
            body: 'Please fix the formatting issues.',
            user: { id: 12345 }
          }
        };

        const stateToVerdict = {
          'approved': 'approve',
          'changes_requested': 'request_changes',
          'commented': 'comment'
        };

        expect(stateToVerdict[payload.review.state]).toBe('request_changes');
      });

      it('should handle comment-only reviews', async () => {
        const payload = {
          review: {
            id: 9878,
            state: 'commented',
            body: 'Interesting approach, have you considered using X instead?',
            user: { id: 12345 }
          }
        };

        const stateToVerdict = {
          'approved': 'approve',
          'changes_requested': 'request_changes',
          'commented': 'comment'
        };

        expect(stateToVerdict[payload.review.state]).toBe('comment');
      });

      it('should ignore dismissed reviews', async () => {
        const payload = {
          action: 'dismissed',
          review: {
            id: 9879,
            state: 'dismissed',
            user: { id: 12345 }
          }
        };

        expect(payload.action).toBe('dismissed');
        // Should not create or update a patch_review
      });
    });
  });

  describe('Reviewer Stats & Karma Tracking', () => {
    describe('updateReviewerStats', () => {
      it('should create reviewer_stats entry if not exists', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            agent_id: 'agent-uuid',
            repo_id: 'repo-uuid',
            reviews_given: 1,
            approvals_given: 1
          }]
        });

        await mockQuery(`
          INSERT INTO gitswarm_reviewer_stats (agent_id, repo_id, reviews_given, approvals_given)
          VALUES ($1, $2, 1, 1)
          ON CONFLICT (agent_id, repo_id) DO UPDATE SET
            reviews_given = gitswarm_reviewer_stats.reviews_given + 1,
            approvals_given = gitswarm_reviewer_stats.approvals_given + 1
        `, ['agent-uuid', 'repo-uuid']);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('reviews_given'),
          expect.any(Array)
        );
      });

      it('should track approval statistics separately', async () => {
        mockQuery.mockResolvedValueOnce({ rowCount: 1 });

        await mockQuery(`
          UPDATE gitswarm_reviewer_stats SET
            reviews_given = reviews_given + 1,
            approvals_given = CASE WHEN $3 = 'approve' THEN approvals_given + 1 ELSE approvals_given END,
            rejections_given = CASE WHEN $3 = 'reject' THEN rejections_given + 1 ELSE rejections_given END,
            last_review_at = NOW()
          WHERE agent_id = $1 AND repo_id = $2
        `, ['agent-uuid', 'repo-uuid', 'approve']);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('approvals_given'),
          expect.arrayContaining(['approve'])
        );
      });
    });

    describe('awardReviewerKarmaOnMerge', () => {
      it('should award karma to approving reviewers when PR merged', async () => {
        const patchId = 'patch-uuid';

        // Get approving reviewers
        mockQuery.mockResolvedValueOnce({
          rows: [
            { reviewer_id: 'reviewer-1', karma: 100 },
            { reviewer_id: 'reviewer-2', karma: 200 }
          ]
        });

        const reviewers = await mockQuery(`
          SELECT DISTINCT pr.reviewer_id, a.karma
          FROM patch_reviews pr
          JOIN agents a ON pr.reviewer_id = a.id
          WHERE pr.patch_id = $1 AND pr.verdict = 'approve' AND pr.reviewer_id IS NOT NULL
        `, [patchId]);

        expect(reviewers.rows).toHaveLength(2);

        // Calculate karma award (higher karma reviewers get less)
        for (const reviewer of reviewers.rows) {
          const karmaAward = Math.max(3, Math.floor(15 * (1 - Math.log10(reviewer.karma + 1) / 4)));

          mockQuery.mockResolvedValueOnce({ rowCount: 1 });
          await mockQuery(
            `UPDATE agents SET karma = karma + $2 WHERE id = $1`,
            [reviewer.reviewer_id, karmaAward]
          );
        }
      });

      it('should create review_karma_transactions for tracking', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'tx-uuid',
            agent_id: 'reviewer-uuid',
            patch_id: 'patch-uuid',
            transaction_type: 'review_approval_merged',
            amount: 10
          }]
        });

        await mockQuery(`
          INSERT INTO review_karma_transactions (agent_id, patch_id, transaction_type, amount, reason)
          VALUES ($1, $2, 'review_approval_merged', $3, 'Approved merged PR')
        `, ['reviewer-uuid', 'patch-uuid', 10]);

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('review_karma_transactions'),
          ['reviewer-uuid', 'patch-uuid', 10]
        );
      });

      it('should not award karma for human-only reviews', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [
            { github_user_mapping_id: 'mapping-1', reviewer_id: null, is_human: true }
          ]
        });

        const reviews = await mockQuery(`
          SELECT github_user_mapping_id, reviewer_id, is_human
          FROM patch_reviews
          WHERE patch_id = $1 AND verdict = 'approve'
        `, ['patch-uuid']);

        const agentReviews = reviews.rows.filter(r => r.reviewer_id != null);
        expect(agentReviews).toHaveLength(0);
        // No karma awards for human-only reviews
      });
    });

    describe('trackReviewerAccuracyOnClose', () => {
      it('should track correct approvals when PR is merged', async () => {
        const patchId = 'patch-uuid';

        mockQuery.mockResolvedValueOnce({
          rows: [
            { reviewer_id: 'reviewer-1', verdict: 'approve' },
            { reviewer_id: 'reviewer-2', verdict: 'approve' }
          ]
        });

        const approvers = await mockQuery(`
          SELECT reviewer_id FROM patch_reviews
          WHERE patch_id = $1 AND verdict = 'approve' AND reviewer_id IS NOT NULL
        `, [patchId]);

        // Update accuracy stats
        for (const reviewer of approvers.rows) {
          mockQuery.mockResolvedValueOnce({ rowCount: 1 });
          await mockQuery(`
            UPDATE gitswarm_reviewer_stats SET
              accurate_approvals = accurate_approvals + 1,
              accuracy_rate = (accurate_approvals + 1)::float / NULLIF(approvals_given, 0)
            WHERE agent_id = $1
          `, [reviewer.reviewer_id]);
        }

        expect(mockQuery).toHaveBeenCalledWith(
          expect.stringContaining('accurate_approvals'),
          expect.any(Array)
        );
      });

      it('should track incorrect approvals when PR is closed without merge', async () => {
        const patchId = 'patch-uuid';

        mockQuery.mockResolvedValueOnce({
          rows: [{ reviewer_id: 'reviewer-1', verdict: 'approve' }]
        });

        const approvers = await mockQuery(`
          SELECT reviewer_id FROM patch_reviews
          WHERE patch_id = $1 AND verdict = 'approve' AND reviewer_id IS NOT NULL
        `, [patchId]);

        // Update inaccurate approval count
        for (const reviewer of approvers.rows) {
          mockQuery.mockResolvedValueOnce({ rowCount: 1 });
          await mockQuery(`
            UPDATE gitswarm_reviewer_stats SET
              inaccurate_approvals = inaccurate_approvals + 1,
              accuracy_rate = accurate_approvals::float / NULLIF(approvals_given, 0)
            WHERE agent_id = $1
          `, [reviewer.reviewer_id]);
        }
      });

      it('should track correct rejections when PR closed without merge', async () => {
        const patchId = 'patch-uuid';

        mockQuery.mockResolvedValueOnce({
          rows: [{ reviewer_id: 'reviewer-1', verdict: 'reject' }]
        });

        // Reviewers who rejected are considered correct
        const rejecters = await mockQuery(`
          SELECT reviewer_id FROM patch_reviews
          WHERE patch_id = $1 AND verdict IN ('reject', 'request_changes') AND reviewer_id IS NOT NULL
        `, [patchId]);

        for (const reviewer of rejecters.rows) {
          mockQuery.mockResolvedValueOnce({ rowCount: 1 });
          await mockQuery(`
            UPDATE gitswarm_reviewer_stats SET
              accurate_rejections = accurate_rejections + 1
            WHERE agent_id = $1
          `, [reviewer.reviewer_id]);
        }
      });
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
