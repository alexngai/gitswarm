/**
 * State Sync Service
 *
 * Generic service that pushes GitSwarm repo state summaries to external systems.
 * Subscribes to MAP EventBus for event-driven triggers, plus periodic full pushes.
 *
 * External systems implement the SyncTarget interface to receive state updates.
 * OpenHive is the first target; any MAP-connected system can be added.
 *
 * Architecture:
 *   MAP EventBus → StateSyncService → SyncTarget.pushState() → external system
 */
import type { MAPServer } from '@multi-agent-protocol/sdk/server';
import { getAllRepoStates, type RepoState } from './repo-state.js';

// ============================================================
// SyncTarget interface
// ============================================================

/**
 * Interface for external systems that receive repo state updates.
 * Implement this to add a new sync target.
 */
export interface SyncTarget {
  /** Unique name for logging and identification */
  readonly name: string;

  /** Whether this target is properly configured and ready */
  readonly isConfigured: boolean;

  /** Push a repo state summary to this target */
  pushState(state: RepoState): Promise<void>;

  /** Optional: register GitSwarm in the target's directory on startup */
  register?(): Promise<void>;
}

// ============================================================
// StateSyncService
// ============================================================

/**
 * Events that trigger a state push.
 */
const SYNC_TRIGGER_EVENTS = [
  'gitswarm.merge.completed',
  'gitswarm.stabilization.passed',
  'gitswarm.stabilization.failed',
  'gitswarm.promotion.completed',
  'gitswarm.stream.created',
  'gitswarm.stream.abandoned',
];

export interface StateSyncOptions {
  /** Push interval in ms (default 30000) */
  syncIntervalMs?: number;
  /** Debounce window for event-triggered pushes in ms (default 5000) */
  debounceMs?: number;
}

export class StateSyncService {
  private mapServer: MAPServer;
  private targets: SyncTarget[] = [];
  private syncIntervalMs: number;
  private debounceMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private eventUnsubscribers: Array<() => void> = [];
  private pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(mapServer: MAPServer, options?: StateSyncOptions) {
    this.mapServer = mapServer;
    this.syncIntervalMs = options?.syncIntervalMs || 30000;
    this.debounceMs = options?.debounceMs || 5000;
  }

  /**
   * Add a sync target. Can be called before or after start().
   */
  addTarget(target: SyncTarget): void {
    if (target.isConfigured) {
      this.targets.push(target);
    }
  }

  /**
   * Get the number of active (configured) targets.
   */
  get targetCount(): number {
    return this.targets.length;
  }

  /**
   * Start the sync service.
   * Subscribes to MAP events and starts periodic push.
   */
  async start(): Promise<void> {
    if (this.targets.length === 0) return;

    // Event-triggered sync
    for (const eventType of SYNC_TRIGGER_EVENTS) {
      const handler = () => this.debouncedPush();
      this.mapServer.eventBus.on(eventType, handler);
      this.eventUnsubscribers.push(() => this.mapServer.eventBus.off(eventType, handler));
    }

    // Periodic full push
    this.intervalHandle = setInterval(() => {
      this.pushAllStates().catch(err => {
        console.warn('State sync: periodic push failed:', err.message);
      });
    }, this.syncIntervalMs);

    // Register with each target
    for (const target of this.targets) {
      if (target.register) {
        await target.register().catch(err => {
          console.warn(`State sync: ${target.name} registration failed:`, (err as Error).message);
        });
      }
    }

    // Initial push
    await this.pushAllStates().catch(err => {
      console.warn('State sync: initial push failed:', err.message);
    });

    const targetNames = this.targets.map(t => t.name).join(', ');
    console.log(`State sync: started (interval: ${this.syncIntervalMs}ms, targets: ${targetNames})`);
  }

  /**
   * Stop the sync service.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.pushDebounceTimer) {
      clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    for (const unsub of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers = [];
  }

  // ============================================================
  // Push logic
  // ============================================================

  private debouncedPush(): void {
    if (this.pushDebounceTimer) return;
    this.pushDebounceTimer = setTimeout(() => {
      this.pushDebounceTimer = null;
      this.pushAllStates().catch(err => {
        console.warn('State sync: event-triggered push failed:', err.message);
      });
    }, this.debounceMs);
  }

  /**
   * Push state for all active repos to all targets.
   * Returns total number of successful pushes (repos × targets).
   */
  async pushAllStates(): Promise<number> {
    const states = await getAllRepoStates();
    let pushed = 0;

    for (const state of states) {
      for (const target of this.targets) {
        try {
          await target.pushState(state);
          pushed++;
        } catch (err) {
          console.warn(`State sync: ${target.name} failed for ${state.repo_name}:`, (err as Error).message);
        }
      }
    }

    return pushed;
  }
}
