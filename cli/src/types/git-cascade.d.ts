declare module 'git-cascade' {
  export class MultiAgentRepoTracker {
    constructor(opts: string | Record<string, unknown>);
    createStream(opts: Record<string, unknown>): string;
    forkStream(opts: Record<string, unknown>): string;
    getStream(streamId: string): Record<string, unknown> | null;
    listStreams(opts?: Record<string, unknown>): Array<Record<string, unknown>>;
    updateStream(streamId: string, opts: Record<string, unknown>): void;
    abandonStream(streamId: string, opts: Record<string, unknown>): void;
    getStreamBranchName(streamId: string): string;
    commitChanges(opts: Record<string, unknown>): { commit: string; changeId: string };
    commitFromWorktree(options: Record<string, unknown>): Record<string, unknown>;
    autoPopulateStack(streamId: string): void;
    setReviewStatus(opts: Record<string, unknown>): void;
    getStack(streamId: string): Record<string, unknown>[];
    getChangesForStream(streamId: string): Record<string, unknown>[];
    getStreamChanges(streamId: string): Array<Record<string, unknown>>;
    getStreamOperations(streamId: string): Array<Record<string, unknown>>;
    getStreamDependencies(streamId: string): Array<Record<string, unknown>>;
    getStreamChildren(streamId: string): Array<Record<string, unknown>>;
    getOperations(opts: Record<string, unknown>): Record<string, unknown>[];
    getDependencies(streamId: string): Record<string, unknown>[];
    getChildStreams(streamId: string): Record<string, unknown>[];
    rollbackToOperation(opts: Record<string, unknown>): void;
    createWorktree(opts: Record<string, unknown>): Record<string, unknown>;
    getWorktree(agentId: string): Record<string, unknown> | null;
    listWorktrees(): Record<string, unknown>[];
    updateWorktreeStream(agentId: string, streamId: string): void;
    deallocateWorktree(agentId: string): void;
    getMergeQueue(opts?: Record<string, unknown>): Record<string, unknown>[];
    queueForMerge(streamId: string, options?: Record<string, unknown>): Record<string, unknown>;
    addToMergeQueue(opts: Record<string, unknown>): Record<string, unknown>;
    cancelMergeQueueEntry(entryId: unknown): void;
    processMergeQueue(options?: Record<string, unknown>): Record<string, unknown>;
    stabilize(options?: Record<string, unknown>): Record<string, unknown>;
    promote(options?: Record<string, unknown>): Record<string, unknown>;
    diff(streamId: string): string;
    diffFull(streamId: string): string;
    close(): void;
    [key: string]: unknown;
  }
}
