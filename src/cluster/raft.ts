import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { RaftClient, GrpcClientPool } from '../grpc/client.js';

export type RaftState = 'follower' | 'candidate' | 'leader';

export interface LogEntry {
  term: number;
  index: number;
  type: LogEntryType;
  data: Buffer;
}

export type LogEntryType =
  | 'noop'
  | 'config_change'
  | 'task_submit'
  | 'task_complete'
  | 'node_join'
  | 'node_leave'
  | 'context_update';

export interface RaftConfig {
  nodeId: string;
  logger: Logger;
  clientPool: GrpcClientPool;
  electionTimeoutMinMs?: number;
  electionTimeoutMaxMs?: number;
  heartbeatIntervalMs?: number;
  maxLogEntriesPerAppend?: number;
}

export interface PeerInfo {
  nodeId: string;
  address: string;
  nextIndex: number;
  matchIndex: number;
  votingMember: boolean;
}

export class RaftNode extends EventEmitter {
  private config: RaftConfig;
  private state: RaftState = 'follower';
  private currentTerm = 0;
  private votedFor: string | null = null;
  private log: LogEntry[] = [];
  private commitIndex = 0;
  private lastApplied = 0;

  // Leader state
  private leaderId: string | null = null;
  private peers: Map<string, PeerInfo> = new Map();

  // Timers
  private electionTimeout: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  // Timing configuration
  private electionTimeoutMin: number;
  private electionTimeoutMax: number;
  private heartbeatMs: number;
  private maxEntriesPerAppend: number;

  private running = false;
  private electionsPaused = false;  // When true, don't start election timers

  constructor(config: RaftConfig) {
    super();
    this.config = config;
    this.electionTimeoutMin = config.electionTimeoutMinMs ?? 150;
    this.electionTimeoutMax = config.electionTimeoutMaxMs ?? 300;
    this.heartbeatMs = config.heartbeatIntervalMs ?? 50;
    this.maxEntriesPerAppend = config.maxLogEntriesPerAppend ?? 100;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.becomeFollower(this.currentTerm);
    this.config.logger.info('Raft node started', { nodeId: this.config.nodeId });
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.config.logger.info('Raft node stopped', { nodeId: this.config.nodeId });
  }

  // Public getters
  getState(): RaftState {
    return this.state;
  }

  getCurrentTerm(): number {
    return this.currentTerm;
  }

  getLeaderId(): string | null {
    return this.leaderId;
  }

  isLeader(): boolean {
    return this.state === 'leader';
  }

  getCommitIndex(): number {
    return this.commitIndex;
  }

  getLastLogIndex(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1].index : 0;
  }

  getLastLogTerm(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1].term : 0;
  }

  // Peer management
  addPeer(nodeId: string, address: string, votingMember: boolean = true): void {
    if (nodeId === this.config.nodeId) return;

    this.peers.set(nodeId, {
      nodeId,
      address,
      nextIndex: this.getLastLogIndex() + 1,
      matchIndex: 0,
      votingMember,
    });

    this.config.logger.info('Added peer', { nodeId, address, votingMember });
  }

  removePeer(nodeId: string): void {
    this.peers.delete(nodeId);
    this.config.logger.info('Removed peer', { nodeId });
  }

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  // Log replication
  async appendEntry(type: LogEntryType, data: Buffer): Promise<{ success: boolean; index: number }> {
    if (this.state !== 'leader') {
      return { success: false, index: -1 };
    }

    const entry: LogEntry = {
      term: this.currentTerm,
      index: this.getLastLogIndex() + 1,
      type,
      data,
    };

    this.log.push(entry);
    this.config.logger.debug('Appended entry', { index: entry.index, type });

    // Replicate to followers
    await this.replicateToFollowers();

    return { success: true, index: entry.index };
  }

  // RPC handlers (called by gRPC service)
  handleRequestVote(request: {
    term: number;
    candidateId: string;
    lastLogIndex: number;
    lastLogTerm: number;
  }): { term: number; voteGranted: boolean } {
    this.config.logger.debug('Received RequestVote', request);

    // Update term if necessary
    if (request.term > this.currentTerm) {
      this.becomeFollower(request.term);
    }

    let voteGranted = false;

    if (request.term >= this.currentTerm) {
      const logOk =
        request.lastLogTerm > this.getLastLogTerm() ||
        (request.lastLogTerm === this.getLastLogTerm() &&
          request.lastLogIndex >= this.getLastLogIndex());

      if (logOk && (this.votedFor === null || this.votedFor === request.candidateId)) {
        voteGranted = true;
        this.votedFor = request.candidateId;
        this.resetElectionTimeout();
      }
    }

    this.config.logger.debug('RequestVote response', { voteGranted, term: this.currentTerm });
    return { term: this.currentTerm, voteGranted };
  }

  handleAppendEntries(request: {
    term: number;
    leaderId: string;
    prevLogIndex: number;
    prevLogTerm: number;
    entries: LogEntry[];
    leaderCommit: number;
  }): { term: number; success: boolean; matchIndex: number } {
    this.config.logger.debug('Received AppendEntries', {
      term: request.term,
      leaderId: request.leaderId,
      entriesCount: request.entries.length,
    });

    // Update term if necessary
    if (request.term > this.currentTerm) {
      this.becomeFollower(request.term);
    }

    if (request.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, matchIndex: 0 };
    }

    // Valid AppendEntries from leader
    this.leaderId = request.leaderId;
    this.resetElectionTimeout();

    // Check log consistency
    if (request.prevLogIndex > 0) {
      const prevEntry = this.log[request.prevLogIndex - 1];
      if (!prevEntry || prevEntry.term !== request.prevLogTerm) {
        return { term: this.currentTerm, success: false, matchIndex: 0 };
      }
    }

    // Append new entries
    let index = request.prevLogIndex;
    for (const entry of request.entries) {
      index++;
      const existingEntry = this.log[index - 1];
      if (!existingEntry) {
        this.log.push(entry);
      } else if (existingEntry.term !== entry.term) {
        // Conflict: delete existing entry and all that follow
        this.log.splice(index - 1);
        this.log.push(entry);
      }
      // Otherwise, entry already exists and matches
    }

    // Update commit index
    if (request.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(request.leaderCommit, this.getLastLogIndex());
      this.applyCommittedEntries();
    }

    return { term: this.currentTerm, success: true, matchIndex: this.getLastLogIndex() };
  }

  // State transitions
  private becomeFollower(term: number): void {
    this.state = 'follower';
    this.currentTerm = term;
    this.votedFor = null;
    this.clearTimers();
    this.resetElectionTimeout();

    this.config.logger.info('Became follower', { term });
    this.emit('stateChange', 'follower', term);
  }

  private becomeCandidate(): void {
    this.state = 'candidate';
    this.currentTerm++;
    this.votedFor = this.config.nodeId;
    this.leaderId = null;

    this.config.logger.info('Became candidate', { term: this.currentTerm });
    this.emit('stateChange', 'candidate', this.currentTerm);

    this.startElection();
  }

  private becomeLeader(): void {
    this.state = 'leader';
    this.leaderId = this.config.nodeId;
    this.clearTimers();

    // Initialize nextIndex and matchIndex for all peers
    const lastLogIndex = this.getLastLogIndex();
    for (const peer of this.peers.values()) {
      peer.nextIndex = lastLogIndex + 1;
      peer.matchIndex = 0;
    }

    this.config.logger.info('Became leader', { term: this.currentTerm });
    this.emit('stateChange', 'leader', this.currentTerm);
    this.emit('leaderElected', this.config.nodeId);

    // Append noop entry to commit entries from previous terms
    this.appendEntry('noop', Buffer.alloc(0));

    // Start heartbeats
    this.startHeartbeats();
  }

  // Election
  private async startElection(): Promise<void> {
    this.resetElectionTimeout();

    const votingPeers = Array.from(this.peers.values()).filter(p => p.votingMember);
    const votesNeeded = Math.floor((votingPeers.length + 1) / 2) + 1;
    let votesReceived = 1; // Vote for self

    this.config.logger.info('Starting election', {
      term: this.currentTerm,
      votesNeeded,
      peerCount: votingPeers.length,
    });

    const votePromises = votingPeers.map(async (peer) => {
      try {
        const client = new RaftClient(this.config.clientPool, peer.address);
        const response = await client.requestVote({
          term: this.currentTerm.toString(),
          candidate_id: this.config.nodeId,
          last_log_index: this.getLastLogIndex().toString(),
          last_log_term: this.getLastLogTerm().toString(),
        });

        const responseTerm = parseInt(response.term);
        if (responseTerm > this.currentTerm) {
          this.becomeFollower(responseTerm);
          return false;
        }

        return response.vote_granted;
      } catch (error) {
        this.config.logger.debug('RequestVote failed', { peer: peer.nodeId, error });
        return false;
      }
    });

    const results = await Promise.all(votePromises);

    if (this.state !== 'candidate') {
      return; // State changed during election
    }

    votesReceived += results.filter(v => v).length;

    this.config.logger.info('Election results', { votesReceived, votesNeeded });

    if (votesReceived >= votesNeeded) {
      this.becomeLeader();
    }
  }

  // Heartbeats and replication
  private startHeartbeats(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.state === 'leader') {
        this.replicateToFollowers();
      }
    }, this.heartbeatMs);
  }

  private async replicateToFollowers(): Promise<void> {
    const peers = Array.from(this.peers.values());

    await Promise.all(peers.map(peer => this.replicateToPeer(peer)));

    // Check if we can advance commit index
    this.updateCommitIndex();
  }

  private async replicateToPeer(peer: PeerInfo): Promise<void> {
    try {
      const prevLogIndex = peer.nextIndex - 1;
      const prevLogTerm = prevLogIndex > 0 ? (this.log[prevLogIndex - 1]?.term ?? 0) : 0;

      const entries = this.log
        .slice(peer.nextIndex - 1, peer.nextIndex - 1 + this.maxEntriesPerAppend)
        .map(e => ({
          term: e.term.toString(),
          index: e.index.toString(),
          type: this.logEntryTypeToProto(e.type),
          data: e.data,
        }));

      const client = new RaftClient(this.config.clientPool, peer.address);
      const response = await client.appendEntries({
        term: this.currentTerm.toString(),
        leader_id: this.config.nodeId,
        prev_log_index: prevLogIndex.toString(),
        prev_log_term: prevLogTerm.toString(),
        entries,
        leader_commit: this.commitIndex.toString(),
      });

      const responseTerm = parseInt(response.term);
      if (responseTerm > this.currentTerm) {
        this.becomeFollower(responseTerm);
        return;
      }

      if (response.success) {
        peer.matchIndex = parseInt(response.match_index);
        peer.nextIndex = peer.matchIndex + 1;
      } else {
        // Decrement nextIndex and retry
        peer.nextIndex = Math.max(1, peer.nextIndex - 1);
      }
    } catch (error) {
      this.config.logger.debug('AppendEntries failed', { peer: peer.nodeId, error });
    }
  }

  private updateCommitIndex(): void {
    // Find the highest index replicated to a majority
    const matchIndices = [this.getLastLogIndex()];
    for (const peer of this.peers.values()) {
      if (peer.votingMember) {
        matchIndices.push(peer.matchIndex);
      }
    }
    matchIndices.sort((a, b) => b - a);

    const majorityIndex = Math.floor(matchIndices.length / 2);
    const newCommitIndex = matchIndices[majorityIndex];

    if (newCommitIndex > this.commitIndex) {
      // Only commit entries from current term
      const entry = this.log[newCommitIndex - 1];
      if (entry && entry.term === this.currentTerm) {
        this.commitIndex = newCommitIndex;
        this.applyCommittedEntries();
      }
    }
  }

  private applyCommittedEntries(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied - 1];
      if (entry) {
        this.emit('entryCommitted', entry);
        this.config.logger.debug('Applied entry', { index: entry.index, type: entry.type });
      }
    }
  }

  // Timer management
  private resetElectionTimeout(): void {
    this.clearElectionTimeout();

    // Don't start election timer if elections are paused (during cluster join)
    if (this.electionsPaused) {
      this.config.logger.debug('Elections paused, not starting election timer');
      return;
    }

    const timeout = this.electionTimeoutMin +
      Math.random() * (this.electionTimeoutMax - this.electionTimeoutMin);

    this.electionTimeout = setTimeout(() => {
      if (this.running && this.state !== 'leader') {
        this.becomeCandidate();
      }
    }, timeout);
  }

  /**
   * Pause elections during cluster join to prevent split-brain.
   * Call this before attempting to join an existing cluster.
   */
  pauseElections(): void {
    this.electionsPaused = true;
    this.clearElectionTimeout();
    this.config.logger.info('Elections paused (joining cluster)');
  }

  /**
   * Resume elections after cluster join completes (success or failure).
   * If join failed, this allows the node to hold elections and potentially become leader.
   */
  resumeElections(): void {
    this.electionsPaused = false;
    if (this.running && this.state !== 'leader') {
      this.resetElectionTimeout();
    }
    this.config.logger.info('Elections resumed');
  }

  /**
   * Check if elections are currently paused.
   */
  areElectionsPaused(): boolean {
    return this.electionsPaused;
  }

  private clearElectionTimeout(): void {
    if (this.electionTimeout) {
      clearTimeout(this.electionTimeout);
      this.electionTimeout = null;
    }
  }

  private clearTimers(): void {
    this.clearElectionTimeout();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private logEntryTypeToProto(type: LogEntryType): string {
    const mapping: Record<LogEntryType, string> = {
      noop: 'LOG_ENTRY_TYPE_NOOP',
      config_change: 'LOG_ENTRY_TYPE_CONFIG_CHANGE',
      task_submit: 'LOG_ENTRY_TYPE_TASK_SUBMIT',
      task_complete: 'LOG_ENTRY_TYPE_TASK_COMPLETE',
      node_join: 'LOG_ENTRY_TYPE_NODE_JOIN',
      node_leave: 'LOG_ENTRY_TYPE_NODE_LEAVE',
      context_update: 'LOG_ENTRY_TYPE_CONTEXT_UPDATE',
    };
    return mapping[type] || 'LOG_ENTRY_TYPE_UNKNOWN';
  }

  // Persistence (should be implemented with actual storage)
  async loadState(): Promise<void> {
    // TODO: Load persistent state from disk
    // - currentTerm
    // - votedFor
    // - log[]
  }

  async saveState(): Promise<void> {
    // TODO: Save persistent state to disk
  }
}
