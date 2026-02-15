import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CouncilCommandsService } from '../../src/services/council-commands.js';

describe('CouncilCommandsService', () => {
  let service: InstanceType<typeof CouncilCommandsService>;
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockQuery = vi.fn();
    service = new CouncilCommandsService({ query: mockQuery } as any);
  });

  // ============================================================
  // Council Management
  // ============================================================

  describe('createCouncil', () => {
    const repoId = 'repo-123';

    it('should create a council with default options', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: repoId, ownership_model: 'guild' }] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            repo_id: repoId,
            min_karma: 1000,
            min_contributions: 5,
            min_members: 3,
            max_members: 9,
            standard_quorum: 2,
            critical_quorum: 3,
            status: 'forming'
          }]
        });

      const result = await service.createCouncil(repoId);

      expect(result.min_karma).toBe(1000);
      expect(result.min_contributions).toBe(5);
      expect(result.status).toBe('forming');
    });

    it('should create a council with custom options', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: repoId, ownership_model: 'guild' }] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            repo_id: repoId,
            min_karma: 5000,
            min_contributions: 10,
            min_members: 5,
            max_members: 15,
            standard_quorum: 3,
            critical_quorum: 5,
            status: 'forming'
          }]
        });

      const result = await service.createCouncil(repoId, {
        min_karma: 5000,
        min_contributions: 10,
        min_members: 5,
        max_members: 15,
        standard_quorum: 3,
        critical_quorum: 5
      });

      expect(result.min_karma).toBe(5000);
      expect(result.min_members).toBe(5);
      expect(result.critical_quorum).toBe(5);
    });

    it('should throw error for non-existent repository', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.createCouncil(repoId)).rejects.toThrow('Repository not found');
    });
  });

  describe('getCouncil', () => {
    it('should return council with member count', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'council-1',
          repo_id: 'repo-123',
          status: 'active',
          member_count: '5'
        }]
      });

      const result = await service.getCouncil('repo-123');

      expect(result.id).toBe('council-1');
      expect(result.member_count).toBe('5');
    });

    it('should return null for non-existent council', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.getCouncil('repo-123');

      expect(result).toBeNull();
    });
  });

  describe('getCouncilMembers', () => {
    it('should return members sorted by role', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { agent_id: 'agent-1', agent_name: 'Chair Agent', karma: 5000, role: 'chair' },
          { agent_id: 'agent-2', agent_name: 'Member Agent', karma: 2000, role: 'member' }
        ]
      });

      const result = await service.getCouncilMembers('council-1');

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('chair');
    });

    it('should return empty array for council with no members', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.getCouncilMembers('council-1');

      expect(result).toEqual([]);
    });
  });

  describe('checkEligibility', () => {
    const agentId = 'agent-123';
    const repoId = 'repo-456';

    it('should return eligible for agent meeting all requirements', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            min_karma: 1000,
            min_contributions: 5,
            max_members: 9
          }]
        })
        .mockResolvedValueOnce({ rows: [{ karma: 2000 }] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }] }) // contributions
        .mockResolvedValueOnce({ rows: [] }) // not already member
        .mockResolvedValueOnce({ rows: [{ count: '3' }] }); // current members

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(true);
    });

    it('should deny when no council exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('no_council');
    });

    it('should deny agent not found', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', min_karma: 1000, min_contributions: 5, max_members: 9 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('agent_not_found');
    });

    it('should deny insufficient karma', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', min_karma: 1000, min_contributions: 5, max_members: 9 }] })
        .mockResolvedValueOnce({ rows: [{ karma: 500 }] });

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('insufficient_karma');
      expect(result.required).toBe(1000);
      expect(result.current).toBe(500);
    });

    it('should deny insufficient contributions', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', min_karma: 1000, min_contributions: 5, max_members: 9 }] })
        .mockResolvedValueOnce({ rows: [{ karma: 2000 }] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] });

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('insufficient_contributions');
      expect(result.required).toBe(5);
      expect(result.current).toBe(2);
    });

    it('should deny already a member', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', min_karma: 1000, min_contributions: 5, max_members: 9 }] })
        .mockResolvedValueOnce({ rows: [{ karma: 2000 }] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'member-1' }] });

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('already_member');
    });

    it('should deny when council is full', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', min_karma: 1000, min_contributions: 5, max_members: 5 }] })
        .mockResolvedValueOnce({ rows: [{ karma: 2000 }] })
        .mockResolvedValueOnce({ rows: [{ count: '10' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '5' }] });

      const result = await service.checkEligibility(agentId, repoId);

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('council_full');
    });
  });

  describe('addMember', () => {
    it('should add member and update council status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ council_id: 'council-1', agent_id: 'agent-1', role: 'member' }] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            member_count: '3',
            min_members: 3,
            status: 'forming'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // status update

      const result = await service.addMember('council-1', 'agent-1', 'member');

      expect(result.role).toBe('member');
    });

    it('should add member as chair', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ council_id: 'council-1', agent_id: 'agent-1', role: 'chair' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', member_count: '1', min_members: 3, status: 'forming' }] });

      const result = await service.addMember('council-1', 'agent-1', 'chair');

      expect(result.role).toBe('chair');
    });
  });

  describe('removeMember', () => {
    it('should remove member', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1', role: 'member' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', member_count: '2', min_members: 3, status: 'active' }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.removeMember('council-1', 'agent-1');

      expect(result.agent_id).toBe('agent-1');
    });

    it('should throw error for non-existent member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.removeMember('council-1', 'agent-1')).rejects.toThrow('Member not found');
    });
  });

  describe('updateCouncilStatus', () => {
    it('should transition from forming to active when min members reached', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            member_count: '3',
            min_members: 3,
            status: 'forming'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.updateCouncilStatus('council-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE gitswarm_repo_councils SET status = $1'),
        ['active', 'council-1']
      );
    });

    it('should transition from active to forming when below min members', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            member_count: '2',
            min_members: 3,
            status: 'active'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.updateCouncilStatus('council-1');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE gitswarm_repo_councils SET status = $1'),
        ['forming', 'council-1']
      );
    });

    it('should not update when status unchanged', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'council-1',
          member_count: '5',
          min_members: 3,
          status: 'active'
        }]
      });

      await service.updateCouncilStatus('council-1');

      // Only one query call (the SELECT)
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Proposals
  // ============================================================

  describe('createProposal', () => {
    it('should create a standard proposal', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            standard_quorum: 2,
            critical_quorum: 3
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            title: 'Test Proposal',
            proposal_type: 'modify_branch_rule',
            quorum_required: 2,
            status: 'open'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 }); // update proposer stats

      const result = await service.createProposal('council-1', 'agent-1', {
        title: 'Test Proposal',
        description: 'A test proposal',
        proposal_type: 'modify_branch_rule'
      });

      expect(result.quorum_required).toBe(2);
      expect(result.status).toBe('open');
    });

    it('should create a critical proposal with higher quorum', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            standard_quorum: 2,
            critical_quorum: 5
          }]
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            title: 'Change Ownership',
            proposal_type: 'change_ownership',
            quorum_required: 5,
            status: 'open'
          }]
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.createProposal('council-1', 'agent-1', {
        title: 'Change Ownership',
        description: 'Transfer ownership',
        proposal_type: 'change_ownership'
      });

      expect(result.quorum_required).toBe(5);
    });

    it('should throw error for non-existent council', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.createProposal('council-1', 'agent-1', {
        title: 'Test',
        proposal_type: 'modify_branch_rule'
      })).rejects.toThrow('Council not found');
    });

    it('should set expires_at based on expires_in_days', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1', standard_quorum: 2, critical_quorum: 3 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'proposal-1', quorum_required: 2 }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await service.createProposal('council-1', 'agent-1', {
        title: 'Test',
        proposal_type: 'modify_branch_rule',
        expires_in_days: 14
      });

      // Check that the INSERT was called with the expires_at parameter
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO gitswarm_council_proposals'),
        expect.arrayContaining(['council-1', 'Test'])
      );
    });
  });

  describe('vote', () => {
    it('should cast a vote successfully', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            expires_at: new Date(Date.now() + 86400000).toISOString()
          }]
        })
        .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] }) // membership check
        .mockResolvedValueOnce({ rowCount: 1 }) // insert vote
        .mockResolvedValueOnce({ rows: [{ vote: 'for', count: '1' }, { vote: 'against', count: '0' }] }) // vote counts
        .mockResolvedValueOnce({ rowCount: 1 }) // update proposal counts
        .mockResolvedValueOnce({ rowCount: 1 }) // update voter stats
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            votes_for: 1,
            votes_against: 0,
            quorum_required: 3,
            total_members: '5',
            expires_at: new Date(Date.now() + 86400000).toISOString()
          }]
        }); // check resolution - quorum not yet reached (1 < 3)

      const result = await service.vote('proposal-1', 'agent-1', 'for');

      expect(result.success).toBe(true);
      expect(result.vote).toBe('for');
    });

    it('should throw error for non-existent proposal', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.vote('proposal-1', 'agent-1', 'for')).rejects.toThrow('Proposal not found');
    });

    it('should throw error for closed proposal', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'proposal-1',
          status: 'passed',
          expires_at: new Date(Date.now() + 86400000).toISOString()
        }]
      });

      await expect(service.vote('proposal-1', 'agent-1', 'for')).rejects.toThrow('Proposal is passed');
    });

    it('should throw error for expired proposal', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'proposal-1',
          council_id: 'council-1',
          status: 'open',
          expires_at: new Date(Date.now() - 86400000).toISOString() // expired
        }]
      });

      await expect(service.vote('proposal-1', 'agent-1', 'for')).rejects.toThrow('Proposal has expired');
    });

    it('should throw error for non-member voting', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            expires_at: new Date(Date.now() + 86400000).toISOString()
          }]
        })
        .mockResolvedValueOnce({ rows: [] }); // not a member

      await expect(service.vote('proposal-1', 'agent-1', 'for')).rejects.toThrow('Only council members can vote');
    });

    it('should allow vote with comment', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            expires_at: new Date(Date.now() + 86400000).toISOString()
          }]
        })
        .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-1' }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ vote: 'for', count: '1' }] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'proposal-1', status: 'open', votes_for: 1, votes_against: 0, quorum_required: 2 }] });

      const result = await service.vote('proposal-1', 'agent-1', 'for', 'I support this change');

      expect(result.success).toBe(true);
    });
  });

  describe('checkProposalResolution', () => {
    it('should pass proposal when quorum reached with majority for', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            votes_for: 3,
            votes_against: 1,
            quorum_required: 3,
            total_members: '5',
            expires_at: new Date(Date.now() + 86400000).toISOString()
          }]
        })
        .mockResolvedValueOnce({ rows: [{ id: 'proposal-1', status: 'passed' }] }) // resolveProposal
        .mockResolvedValueOnce({ rows: [{ repo_id: 'repo-1' }] }) // get council for execution
        .mockResolvedValueOnce({ rowCount: 1 }); // execution result

      const result = await service.checkProposalResolution('proposal-1');

      expect(result).toBe('passed');
    });

    it('should reject proposal when quorum reached with majority against', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            votes_for: 1,
            votes_against: 3,
            quorum_required: 3,
            total_members: '5',
            expires_at: new Date(Date.now() + 86400000).toISOString()
          }]
        })
        .mockResolvedValueOnce({ rows: [{ id: 'proposal-1', status: 'rejected' }] });

      const result = await service.checkProposalResolution('proposal-1');

      expect(result).toBe('rejected');
    });

    it('should expire proposal when past deadline', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            status: 'open',
            votes_for: 1,
            votes_against: 0,
            quorum_required: 3,
            total_members: '5',
            expires_at: new Date(Date.now() - 86400000).toISOString() // expired
          }]
        })
        .mockResolvedValueOnce({ rows: [{ id: 'proposal-1', status: 'expired' }] });

      const result = await service.checkProposalResolution('proposal-1');

      expect(result).toBe('expired');
    });

    it('should return null when quorum not reached and not expired', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'proposal-1',
          council_id: 'council-1',
          status: 'open',
          votes_for: 1,
          votes_against: 0,
          quorum_required: 3,
          total_members: '5',
          expires_at: new Date(Date.now() + 86400000).toISOString()
        }]
      });

      const result = await service.checkProposalResolution('proposal-1');

      expect(result).toBeNull();
    });

    it('should return null for non-existent or closed proposal', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.checkProposalResolution('proposal-1');

      expect(result).toBeNull();
    });
  });

  describe('resolveProposal', () => {
    it('should resolve and execute passed proposal', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'proposal-1',
            council_id: 'council-1',
            proposal_type: 'add_maintainer',
            action_data: { agent_id: 'agent-123', role: 'maintainer' },
            status: 'passed'
          }]
        })
        .mockResolvedValueOnce({ rows: [{ repo_id: 'repo-1' }] }) // get council
        .mockResolvedValueOnce({ rowCount: 1 }) // add maintainer
        .mockResolvedValueOnce({ rowCount: 1 }); // record execution

      const result = await service.resolveProposal('proposal-1', 'passed');

      expect(result.status).toBe('passed');
    });

    it('should not execute rejected proposal', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'proposal-1',
          council_id: 'council-1',
          proposal_type: 'add_maintainer',
          status: 'rejected'
        }]
      });

      const result = await service.resolveProposal('proposal-1', 'rejected');

      expect(result.status).toBe('rejected');
      // Should only have one query call (the UPDATE)
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should throw error for non-existent proposal', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.resolveProposal('proposal-1', 'passed')).rejects.toThrow('Proposal not found');
    });
  });

  // ============================================================
  // Action Executors
  // ============================================================

  describe('executeAddMaintainer', () => {
    it('should add maintainer to repo', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.executeAddMaintainer('repo-1', {
        agent_id: 'agent-123',
        role: 'maintainer'
      });

      expect(result.executed).toBe(true);
      expect(result.action).toBe('add_maintainer');
      expect(result.agent_id).toBe('agent-123');
    });
  });

  describe('executeRemoveMaintainer', () => {
    it('should remove maintainer from repo', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.executeRemoveMaintainer('repo-1', {
        agent_id: 'agent-123'
      });

      expect(result.executed).toBe(true);
      expect(result.action).toBe('remove_maintainer');
    });
  });

  describe('executeModifyAccess', () => {
    it('should modify agent access level', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });

      const result = await service.executeModifyAccess('repo-1', {
        agent_id: 'agent-123',
        access_level: 'write'
      });

      expect(result.executed).toBe(true);
      expect(result.access_level).toBe('write');
    });
  });

  // ============================================================
  // Command Parsing
  // ============================================================

  describe('parseCommand', () => {
    it('should parse status command', () => {
      const result = service.parseCommand('/council status');

      expect(result.command).toBe('status');
      expect(result.args).toEqual([]);
    });

    it('should parse nominate command with argument', () => {
      const result = service.parseCommand('/council nominate @agent-123');

      expect(result.command).toBe('nominate');
      expect(result.args).toEqual(['@agent-123']);
    });

    it('should parse vote command with arguments', () => {
      const result = service.parseCommand('/council vote proposal-1 yes');

      expect(result.command).toBe('vote');
      expect(result.args).toEqual(['proposal-1', 'yes']);
    });

    it('should parse members command', () => {
      const result = service.parseCommand('/council members');

      expect(result.command).toBe('members');
    });

    it('should return null for non-council commands', () => {
      expect(service.parseCommand('/help')).toBeNull();
      expect(service.parseCommand('regular text')).toBeNull();
      expect(service.parseCommand('')).toBeNull();
    });

    it('should be case insensitive', () => {
      const result = service.parseCommand('/COUNCIL STATUS');

      expect(result.command).toBe('status');
    });
  });

  describe('executeCommand', () => {
    it('should execute status command', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'council-1',
            status: 'active',
            min_members: 3,
            max_members: 9
          }]
        })
        .mockResolvedValueOnce({
          rows: [
            { agent_name: 'Agent 1', role: 'chair', karma: 5000 },
            { agent_name: 'Agent 2', role: 'member', karma: 2000 }
          ]
        })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }); // open proposals

      const result = await service.executeCommand(
        { command: 'status', args: [] },
        { agentId: 'agent-1', repoId: 'repo-1' }
      );

      expect(result.council.status).toBe('active');
      expect(result.members).toHaveLength(2);
    });

    it('should execute members command', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'council-1' }] })
        .mockResolvedValueOnce({
          rows: [
            { agent_id: 'a1', agent_name: 'Agent 1', role: 'chair', karma: 5000, votes_cast: 10, proposals_made: 3 }
          ]
        });

      const result = await service.executeCommand(
        { command: 'members', args: [] },
        { agentId: 'agent-1', repoId: 'repo-1' }
      );

      expect(result.members).toHaveLength(1);
      expect(result.members[0].votes_cast).toBe(10);
    });

    it('should return error for unknown command', async () => {
      const result = await service.executeCommand(
        { command: 'unknown', args: [] },
        { agentId: 'agent-1', repoId: 'repo-1' }
      );

      expect(result.error).toBe('Unknown council command: unknown');
    });

    it('should handle status with no council', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.executeCommand(
        { command: 'status', args: [] },
        { agentId: 'agent-1', repoId: 'repo-1' }
      );

      expect(result.message).toBe('No council exists for this repository');
    });
  });
});
