import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CouncilCommandsService } from '../../src/services/council-commands.js';

describe('CouncilCommandsService - Elections', () => {
  let councilCommands: InstanceType<typeof CouncilCommandsService>;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    councilCommands = new CouncilCommandsService({ query: mockQuery } as any);
  });

  describe('startElection', () => {
    it('should start a new election', async () => {
      // Council exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'council-uuid' }] });
      // No active election
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Create election
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'election-uuid',
          council_id: 'council-uuid',
          status: 'nominations',
          seats_available: 2
        }]
      });

      const election = await councilCommands.startElection('council-uuid', 'creator-uuid', {
        seats_available: 2,
        nominations_days: 5,
        voting_days: 3
      });

      expect(election.id).toBe('election-uuid');
      expect(election.status).toBe('nominations');
      expect(election.seats_available).toBe(2);
    });

    it('should reject if council not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(councilCommands.startElection('bad-council', 'creator-uuid', {}))
        .rejects.toThrow('Council not found');
    });

    it('should reject if election already in progress', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'council-uuid' }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'active-election' }] });

      await expect(councilCommands.startElection('council-uuid', 'creator-uuid', {}))
        .rejects.toThrow('already in progress');
    });
  });

  describe('nominateCandidate', () => {
    beforeEach(() => {
      // Mock getElection
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'election-uuid',
          council_id: 'council-uuid',
          repo_id: 'repo-uuid',
          status: 'nominations'
        }]
      });
    });

    it('should nominate an eligible candidate', async () => {
      // Get council for eligibility check
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'council-uuid', min_karma: 100, min_contributions: 3, max_members: 9 }]
      });
      // Agent karma check
      mockQuery.mockResolvedValueOnce({ rows: [{ karma: 500 }] });
      // Contribution count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });
      // Not already a member
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Member count
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
      // Create nomination
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'candidate-uuid', agent_id: 'nominee-uuid', status: 'nominated' }]
      });

      const candidate = await councilCommands.nominateCandidate(
        'election-uuid', 'nominee-uuid', 'nominator-uuid', 'My statement'
      );

      expect(candidate.agent_id).toBe('nominee-uuid');
      expect(candidate.status).toBe('nominated');
    });

    it('should reject if nominations closed', async () => {
      // Reset mock and set status to voting
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'election-uuid',
          status: 'voting'
        }]
      });

      await expect(councilCommands.nominateCandidate('election-uuid', 'agent-uuid', 'agent-uuid'))
        .rejects.toThrow('Nominations are closed');
    });
  });

  describe('acceptNomination', () => {
    it('should accept a pending nomination', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'candidate-uuid', agent_id: 'agent-uuid', status: 'accepted' }]
      });

      const candidate = await councilCommands.acceptNomination('candidate-uuid', 'agent-uuid');

      expect(candidate.status).toBe('accepted');
    });

    it('should reject if nomination not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(councilCommands.acceptNomination('bad-candidate', 'agent-uuid'))
        .rejects.toThrow('not found or already processed');
    });
  });

  describe('withdrawCandidacy', () => {
    it('should withdraw a candidacy', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'candidate-uuid', status: 'withdrawn' }]
      });

      const candidate = await councilCommands.withdrawCandidacy('candidate-uuid', 'agent-uuid');

      expect(candidate.status).toBe('withdrawn');
    });
  });

  describe('startVoting', () => {
    it('should transition to voting phase', async () => {
      // Get election
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'election-uuid', status: 'nominations', seats_available: 2 }]
      });
      // Get candidates
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'candidate-1', agent_id: 'agent-1' },
          { id: 'candidate-2', agent_id: 'agent-2' },
          { id: 'candidate-3', agent_id: 'agent-3' }
        ]
      });
      // Update status
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await councilCommands.startVoting('election-uuid');

      expect(result.success).toBe(true);
      expect(result.candidates_count).toBe(3);
    });

    it('should reject if not enough candidates', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'election-uuid', status: 'nominations', seats_available: 3 }]
      });
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'candidate-1' }]
      });

      await expect(councilCommands.startVoting('election-uuid'))
        .rejects.toThrow('Not enough candidates');
    });
  });

  describe('castElectionVote', () => {
    beforeEach(() => {
      // Get election
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'election-uuid',
          council_id: 'council-uuid',
          status: 'voting'
        }]
      });
    });

    it('should cast a vote', async () => {
      // Check voter is council member
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'voter-uuid' }] });
      // Check candidate exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'candidate-uuid' }] });
      // Check no existing vote
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Record vote
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Update vote count
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await councilCommands.castElectionVote('election-uuid', 'voter-uuid', 'candidate-uuid');

      expect(result.success).toBe(true);
      expect(result.voted_for).toBe('candidate-uuid');
    });

    it('should reject non-member voters', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // Not a member

      await expect(councilCommands.castElectionVote('election-uuid', 'voter-uuid', 'candidate-uuid'))
        .rejects.toThrow('Only council members');
    });

    it('should reject duplicate votes', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'voter-uuid' }] }); // Is member
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'candidate-uuid' }] }); // Candidate exists
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-vote' }] }); // Already voted

      await expect(councilCommands.castElectionVote('election-uuid', 'voter-uuid', 'candidate-uuid'))
        .rejects.toThrow('already voted');
    });
  });

  describe('completeElection', () => {
    it('should complete election and elect winners', async () => {
      // Get election
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'election-uuid',
          council_id: 'council-uuid',
          seats_available: 2,
          status: 'voting'
        }]
      });
      // Get candidates sorted by votes
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'candidate-1', agent_id: 'agent-1', agent_name: 'Winner 1', vote_count: 5 },
          { id: 'candidate-2', agent_id: 'agent-2', agent_name: 'Winner 2', vote_count: 4 },
          { id: 'candidate-3', agent_id: 'agent-3', agent_name: 'Loser', vote_count: 2 }
        ]
      });
      // Get term limit
      mockQuery.mockResolvedValueOnce({ rows: [{ term_limit_months: 12 }] });
      // Update winner 1
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Update winner 2
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Update loser
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Complete election
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Update council status
      mockQuery.mockResolvedValueOnce({ rows: [{ member_count: '5', min_members: 3, status: 'active' }] });

      const result = await councilCommands.completeElection('election-uuid');

      expect(result.success).toBe(true);
      expect(result.winners).toHaveLength(2);
      expect(result.winners[0].name).toBe('Winner 1');
      expect(result.winners[0].votes).toBe(5);
      expect(result.term_expires_at).toBeDefined();
    });

    it('should reject if not in voting phase', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'election-uuid', status: 'nominations' }]
      });

      await expect(councilCommands.completeElection('election-uuid'))
        .rejects.toThrow('not in voting phase');
    });
  });

  describe('getElectionResults', () => {
    it('should return election results', async () => {
      // Get election
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'election-uuid',
          status: 'completed',
          seats_available: 2,
          completed_at: new Date()
        }]
      });
      // Get candidates
      mockQuery.mockResolvedValueOnce({
        rows: [
          { agent_id: 'agent-1', agent_name: 'Winner', karma: 500, vote_count: 5, status: 'elected' },
          { agent_id: 'agent-2', agent_name: 'Loser', karma: 300, vote_count: 2, status: 'not_elected' }
        ]
      });
      // Get total voters
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });

      const results = await councilCommands.getElectionResults('election-uuid');

      expect(results.election.status).toBe('completed');
      expect(results.candidates).toHaveLength(2);
      expect(results.candidates[0].status).toBe('elected');
      expect(results.total_voters).toBe(7);
    });
  });

  describe('checkExpiredTerms', () => {
    it('should remove members with expired terms', async () => {
      // Find expired members
      mockQuery.mockResolvedValueOnce({
        rows: [
          { agent_id: 'expired-agent-1' },
          { agent_id: 'expired-agent-2' }
        ]
      });
      // Remove member 1
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'expired-agent-1' }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ member_count: '3', min_members: 3, status: 'active' }] });
      // Remove member 2
      mockQuery.mockResolvedValueOnce({ rows: [{ agent_id: 'expired-agent-2' }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ member_count: '2', min_members: 3, status: 'active' }] });

      const result = await councilCommands.checkExpiredTerms('council-uuid');

      expect(result.expired_count).toBe(2);
      expect(result.removed).toContain('expired-agent-1');
      expect(result.removed).toContain('expired-agent-2');
    });
  });
});
