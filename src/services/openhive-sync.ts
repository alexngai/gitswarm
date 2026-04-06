/**
 * OpenHive Sync Target
 *
 * Implements the SyncTarget interface for pushing GitSwarm repo state
 * to OpenHive's coordination contexts. Also handles optional swarm
 * registration in OpenHive's directory.
 *
 * This is one implementation of the generic sync pattern. Other systems
 * can implement SyncTarget to receive the same repo state summaries.
 *
 * Requires: OPENHIVE_URL and OPENHIVE_API_KEY env vars.
 */
import { config } from '../config/env.js';
import { query } from '../config/database.js';
import type { SyncTarget } from './state-sync.js';
import type { RepoState } from './repo-state.js';

export interface OpenHiveSyncOptions {
  openhiveUrl?: string;
  apiKey?: string;
  syncIntervalMs?: number;
}

export class OpenHiveSyncTarget implements SyncTarget {
  readonly name = 'openhive';

  private openhiveUrl: string;
  private apiKey: string;
  private syncIntervalMs: number;
  private swarmId: string | null = null;

  constructor(options?: OpenHiveSyncOptions) {
    this.openhiveUrl = options?.openhiveUrl !== undefined ? options.openhiveUrl : (config.openhive.url || '');
    this.apiKey = options?.apiKey !== undefined ? options.apiKey : (config.openhive.apiKey || '');
    this.syncIntervalMs = options?.syncIntervalMs || config.openhive.syncIntervalMs;
  }

  get isConfigured(): boolean {
    return !!(this.openhiveUrl && this.apiKey);
  }

  /**
   * Push a repo state to OpenHive's coordination contexts endpoint.
   */
  async pushState(state: RepoState): Promise<void> {
    const url = `${this.openhiveUrl}/api/v1/coordination/contexts`;
    const ttlSeconds = Math.ceil(this.syncIntervalMs / 1000) * 2;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_swarm_id: this.swarmId || 'gitswarm',
        context_type: 'git-repo-state',
        data: state,
        ttl_seconds: ttlSeconds,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenHive API ${res.status}: ${text}`);
    }
  }

  /**
   * Register GitSwarm as a swarm in OpenHive's directory.
   */
  async register(): Promise<void> {
    try {
      const repos = await query(
        "SELECT name FROM gitswarm_repos WHERE status = 'active' AND git_backend = 'gitea'"
      );
      const repoNames = repos.rows.map((r: any) => r.name);

      const mapEndpoint = `ws://${config.host}:${config.port}/ws`;

      const res = await fetch(`${this.openhiveUrl}/api/v1/map/swarms`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'gitswarm',
          description: 'Git governance server',
          map_endpoint: mapEndpoint,
          map_transport: 'websocket',
          capabilities: {
            messaging: true,
            lifecycle: true,
            protocols: ['git-coordination'],
          },
          auth_method: 'api-key',
          metadata: {
            type: 'git-governance',
            repos: repoNames,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json() as { id: string };
        this.swarmId = data.id;
        console.log(`OpenHive sync: registered as swarm ${this.swarmId}`);
      } else if (res.status === 409) {
        console.log('OpenHive sync: swarm already registered');
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`OpenHive sync: registration failed (${res.status}): ${text}`);
      }
    } catch (err) {
      console.warn('OpenHive sync: registration error:', (err as Error).message);
    }
  }
}
