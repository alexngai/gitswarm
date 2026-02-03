import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BountyService } from '../../src/services/bounty.js';

describe('BountyService', () => {
  let bountyService;
  let mockQuery;

  beforeEach(() => {
    mockQuery = vi.fn();
    bountyService = new BountyService({ query: mockQuery });
  });

  describe('Budget Management', () => {
    describe('getOrCreateBudget', () => {
      it('should return existing budget', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'budget-uuid', repo_id: 'repo-uuid', available_credits: 1000 }]
        });

        const budget = await bountyService.getOrCreateBudget('repo-uuid');

        expect(budget.available_credits).toBe(1000);
        expect(mockQuery).toHaveBeenCalledTimes(1);
      });

      it('should create budget if not exists', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'new-budget', repo_id: 'repo-uuid', available_credits: 0 }]
        });

        const budget = await bountyService.getOrCreateBudget('repo-uuid');

        expect(budget.available_credits).toBe(0);
        expect(mockQuery).toHaveBeenCalledTimes(2);
      });
    });

    describe('depositCredits', () => {
      it('should add credits to budget', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'budget-uuid', available_credits: 500 }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await bountyService.depositCredits('repo-uuid', 200, 'agent-uuid', 'Test deposit');

        expect(result.success).toBe(true);
        expect(result.new_balance).toBe(700);
      });

      it('should reject zero or negative deposits', async () => {
        await expect(bountyService.depositCredits('repo-uuid', 0, 'agent-uuid')).rejects.toThrow('positive');
        await expect(bountyService.depositCredits('repo-uuid', -100, 'agent-uuid')).rejects.toThrow('positive');
      });
    });

    describe('withdrawCredits', () => {
      it('should remove credits from budget', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'budget-uuid', available_credits: 500 }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await bountyService.withdrawCredits('repo-uuid', 200, 'agent-uuid');

        expect(result.success).toBe(true);
        expect(result.new_balance).toBe(300);
      });

      it('should reject insufficient credits', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'budget-uuid', available_credits: 100 }]
        });

        await expect(bountyService.withdrawCredits('repo-uuid', 500, 'agent-uuid')).rejects.toThrow('Insufficient');
      });
    });
  });

  describe('Bounty Management', () => {
    describe('createBounty', () => {
      it('should create a bounty with valid data', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'budget-uuid',
            available_credits: 1000,
            max_bounty_per_issue: 500,
            min_bounty_amount: 10
          }]
        });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-uuid', amount: 100, github_issue_number: 42 }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update budget
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Record transaction

        const bounty = await bountyService.createBounty('repo-uuid', {
          github_issue_number: 42,
          title: 'Fix bug',
          amount: 100
        }, 'agent-uuid');

        expect(bounty.amount).toBe(100);
        expect(bounty.github_issue_number).toBe(42);
      });

      it('should reject bounty exceeding max', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'budget-uuid',
            available_credits: 1000,
            max_bounty_per_issue: 100,
            min_bounty_amount: 10
          }]
        });

        await expect(bountyService.createBounty('repo-uuid', {
          github_issue_number: 1,
          title: 'Test',
          amount: 500
        }, 'agent-uuid')).rejects.toThrow('exceeds maximum');
      });

      it('should reject bounty below min', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'budget-uuid',
            available_credits: 1000,
            max_bounty_per_issue: 500,
            min_bounty_amount: 50
          }]
        });

        await expect(bountyService.createBounty('repo-uuid', {
          github_issue_number: 1,
          title: 'Test',
          amount: 10
        }, 'agent-uuid')).rejects.toThrow('at least');
      });

      it('should reject when insufficient budget', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'budget-uuid',
            available_credits: 50,
            max_bounty_per_issue: 500,
            min_bounty_amount: 10
          }]
        });

        await expect(bountyService.createBounty('repo-uuid', {
          github_issue_number: 1,
          title: 'Test',
          amount: 100
        }, 'agent-uuid')).rejects.toThrow('Insufficient');
      });
    });

    describe('cancelBounty', () => {
      it('should cancel an open bounty and return credits', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-uuid', status: 'open', amount: 100, repo_id: 'repo-uuid' }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update bounty
        mockQuery.mockResolvedValueOnce({
          rows: [{ available_credits: 500 }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update budget
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Record transaction

        const result = await bountyService.cancelBounty('bounty-uuid', 'agent-uuid');

        expect(result.success).toBe(true);
      });

      it('should reject canceling non-open bounty', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-uuid', status: 'completed', amount: 100 }]
        });

        await expect(bountyService.cancelBounty('bounty-uuid', 'agent-uuid')).rejects.toThrow('Cannot cancel');
      });
    });
  });

  describe('Bounty Claims', () => {
    describe('claimBounty', () => {
      it('should create a claim for open bounty', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-uuid', status: 'open' }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Check existing claim
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'claim-uuid', bounty_id: 'bounty-uuid', agent_id: 'agent-uuid' }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update bounty status

        const claim = await bountyService.claimBounty('bounty-uuid', 'agent-uuid');

        expect(claim.bounty_id).toBe('bounty-uuid');
      });

      it('should reject claiming non-open bounty', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-uuid', status: 'completed' }]
        });

        await expect(bountyService.claimBounty('bounty-uuid', 'agent-uuid')).rejects.toThrow('Cannot claim');
      });

      it('should reject duplicate claims', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-uuid', status: 'open' }]
        });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'existing-claim' }]
        });

        await expect(bountyService.claimBounty('bounty-uuid', 'agent-uuid')).rejects.toThrow('already claimed');
      });
    });

    describe('submitClaim', () => {
      it('should submit an active claim', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'claim-uuid', agent_id: 'agent-uuid', status: 'active', bounty_id: 'bounty-uuid' }]
        });
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'claim-uuid', status: 'submitted' }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update bounty status

        const claim = await bountyService.submitClaim('claim-uuid', 'agent-uuid', {
          pr_url: 'https://github.com/org/repo/pull/1',
          notes: 'Fixed the bug'
        });

        expect(claim.status).toBe('submitted');
      });

      it('should reject submitting non-active claim', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'claim-uuid', agent_id: 'agent-uuid', status: 'submitted' }]
        });

        await expect(bountyService.submitClaim('claim-uuid', 'agent-uuid', {})).rejects.toThrow('Cannot submit');
      });
    });

    describe('reviewClaim', () => {
      it('should approve claim and pay out', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'claim-uuid',
            status: 'submitted',
            agent_id: 'claimer-uuid',
            amount: 100,
            repo_id: 'repo-uuid',
            bounty_id: 'bounty-uuid'
          }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update claim
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update bounty
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update budget
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Award karma
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Record transaction

        const result = await bountyService.reviewClaim('claim-uuid', 'reviewer-uuid', 'approve', 'Good work!');

        expect(result.action).toBe('approved');
        expect(result.amount_paid).toBe(100);
      });

      it('should reject claim and reopen bounty', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{
            id: 'claim-uuid',
            status: 'submitted',
            agent_id: 'claimer-uuid',
            bounty_id: 'bounty-uuid'
          }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update claim
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Reopen bounty

        const result = await bountyService.reviewClaim('claim-uuid', 'reviewer-uuid', 'reject', 'Not complete');

        expect(result.action).toBe('rejected');
      });
    });

    describe('abandonClaim', () => {
      it('should abandon an active claim', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'claim-uuid', agent_id: 'agent-uuid', status: 'active', bounty_id: 'bounty-uuid' }]
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Update claim
        mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // Check other claims
        mockQuery.mockResolvedValueOnce({ rows: [] }); // Reopen bounty

        const result = await bountyService.abandonClaim('claim-uuid', 'agent-uuid');

        expect(result.success).toBe(true);
      });
    });
  });

  describe('Query Methods', () => {
    describe('listBounties', () => {
      it('should list bounties for a repo', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [
            { id: 'bounty-1', title: 'Bug 1', amount: 50 },
            { id: 'bounty-2', title: 'Bug 2', amount: 100 }
          ]
        });

        const bounties = await bountyService.listBounties('repo-uuid');

        expect(bounties).toHaveLength(2);
      });

      it('should filter by status', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'bounty-1', status: 'open' }]
        });

        await bountyService.listBounties('repo-uuid', { status: 'open' });

        expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('status'), expect.arrayContaining(['open']));
      });
    });

    describe('listClaims', () => {
      it('should list claims for a bounty', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [
            { id: 'claim-1', agent_name: 'Agent 1' },
            { id: 'claim-2', agent_name: 'Agent 2' }
          ]
        });

        const claims = await bountyService.listClaims('bounty-uuid');

        expect(claims).toHaveLength(2);
      });
    });

    describe('getAgentClaims', () => {
      it('should list claims by agent', async () => {
        mockQuery.mockResolvedValueOnce({
          rows: [{ id: 'claim-1', bounty_title: 'Fix bug' }]
        });

        const claims = await bountyService.getAgentClaims('agent-uuid');

        expect(claims).toHaveLength(1);
      });
    });
  });
});
