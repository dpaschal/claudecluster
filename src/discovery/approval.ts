import { EventEmitter } from 'events';
import { Logger } from 'winston';
import { NodeInfo, NodeResources } from '../cluster/membership.js';

export interface ApprovalRequest {
  requestId: string;
  node: NodeInfo;
  requestedAt: number;
  expiresAt: number;
  ephemeral: boolean;
  reason?: string;
}

export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  decidedBy: string;
  decidedAt: number;
  reason?: string;
}

export interface ApprovalWorkflowConfig {
  logger: Logger;
  requestTimeoutMs?: number;
  autoApproveEphemeral?: boolean;
  autoApproveTags?: string[];
  maxPendingRequests?: number;
}

export type ApprovalCallback = (request: ApprovalRequest) => Promise<boolean>;

export class ApprovalWorkflow extends EventEmitter {
  private config: ApprovalWorkflowConfig;
  private pendingRequests: Map<string, ApprovalRequest> = new Map();
  private approvalCallback: ApprovalCallback | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  private requestTimeoutMs: number;
  private maxPending: number;

  constructor(config: ApprovalWorkflowConfig) {
    super();
    this.config = config;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 5 * 60 * 1000; // 5 minutes
    this.maxPending = config.maxPendingRequests ?? 100;
  }

  start(): void {
    // Clean up expired requests every minute
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60000);
    this.config.logger.info('Approval workflow started');
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.config.logger.info('Approval workflow stopped');
  }

  // Set callback for interactive approval
  setApprovalCallback(callback: ApprovalCallback): void {
    this.approvalCallback = callback;
  }

  // Request approval for a new node
  async requestApproval(node: NodeInfo): Promise<ApprovalDecision> {
    const requestId = `${node.nodeId}-${Date.now()}`;
    const now = Date.now();

    // Check if auto-approve applies
    const autoApproval = this.checkAutoApproval(node);
    if (autoApproval.approved) {
      this.config.logger.info('Node auto-approved', {
        nodeId: node.nodeId,
        reason: autoApproval.reason,
      });

      return {
        requestId,
        approved: true,
        decidedBy: 'auto',
        decidedAt: now,
        reason: autoApproval.reason,
      };
    }

    // Check pending limit
    if (this.pendingRequests.size >= this.maxPending) {
      this.config.logger.warn('Too many pending approval requests');
      return {
        requestId,
        approved: false,
        decidedBy: 'system',
        decidedAt: now,
        reason: 'Too many pending requests',
      };
    }

    const request: ApprovalRequest = {
      requestId,
      node,
      requestedAt: now,
      expiresAt: now + this.requestTimeoutMs,
      ephemeral: node.tags.includes('ephemeral'),
    };

    this.pendingRequests.set(requestId, request);

    // Emit event for UI/notification
    this.emit('approvalRequired', request);
    this.config.logger.info('Approval request created', {
      requestId,
      nodeId: node.nodeId,
      hostname: node.hostname,
    });

    // If there's a callback, use it
    if (this.approvalCallback) {
      try {
        const approved = await this.approvalCallback(request);
        return this.decide(requestId, approved, 'callback');
      } catch (error) {
        this.config.logger.error('Approval callback failed', { error, requestId });
        return {
          requestId,
          approved: false,
          decidedBy: 'system',
          decidedAt: Date.now(),
          reason: 'Callback error',
        };
      }
    }

    // Wait for manual decision or timeout
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const req = this.pendingRequests.get(requestId);

        if (!req) {
          // Request was decided
          clearInterval(checkInterval);
          resolve({
            requestId,
            approved: false,
            decidedBy: 'unknown',
            decidedAt: Date.now(),
          });
        } else if (Date.now() > req.expiresAt) {
          // Request expired
          clearInterval(checkInterval);
          this.pendingRequests.delete(requestId);
          this.config.logger.info('Approval request expired', { requestId });
          this.emit('approvalExpired', request);
          resolve({
            requestId,
            approved: false,
            decidedBy: 'timeout',
            decidedAt: Date.now(),
            reason: 'Request expired',
          });
        }
      }, 1000);

      // Listen for decision
      this.once(`decision:${requestId}`, (decision: ApprovalDecision) => {
        clearInterval(checkInterval);
        resolve(decision);
      });
    });
  }

  // Make approval decision
  decide(requestId: string, approved: boolean, decidedBy: string, reason?: string): ApprovalDecision {
    const request = this.pendingRequests.get(requestId);

    if (!request) {
      this.config.logger.warn('Approval request not found', { requestId });
      return {
        requestId,
        approved: false,
        decidedBy: 'system',
        decidedAt: Date.now(),
        reason: 'Request not found',
      };
    }

    this.pendingRequests.delete(requestId);

    const decision: ApprovalDecision = {
      requestId,
      approved,
      decidedBy,
      decidedAt: Date.now(),
      reason,
    };

    this.config.logger.info('Approval decision made', {
      requestId,
      nodeId: request.node.nodeId,
      approved,
      decidedBy,
    });

    this.emit(`decision:${requestId}`, decision);
    this.emit(approved ? 'approved' : 'rejected', request, decision);

    return decision;
  }

  // Get pending requests
  getPendingRequests(): ApprovalRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  // Get a specific request
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  // Cancel a pending request
  cancelRequest(requestId: string): boolean {
    const request = this.pendingRequests.get(requestId);
    if (request) {
      this.pendingRequests.delete(requestId);
      this.emit('approvalCancelled', request);
      return true;
    }
    return false;
  }

  // Auto-approval logic
  private checkAutoApproval(node: NodeInfo): { approved: boolean; reason?: string } {
    // Auto-approve ephemeral nodes if configured
    if (this.config.autoApproveEphemeral && node.tags.includes('ephemeral')) {
      return { approved: true, reason: 'Ephemeral node auto-approved' };
    }

    // Auto-approve nodes with specific tags
    if (this.config.autoApproveTags) {
      for (const tag of this.config.autoApproveTags) {
        if (node.tags.includes(tag)) {
          return { approved: true, reason: `Tag ${tag} auto-approved` };
        }
      }
    }

    return { approved: false };
  }

  // Clean up expired requests
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [requestId, request] of this.pendingRequests) {
      if (now > request.expiresAt) {
        this.pendingRequests.delete(requestId);
        this.emit('approvalExpired', request);
      }
    }
  }

  // Format approval request for display
  static formatRequest(request: ApprovalRequest): string {
    const node = request.node;
    const resources = node.resources;

    let output = `
🖥️  New node wants to join the cluster!

Node: ${node.hostname} (${node.tailscaleIp})
Type: ${request.ephemeral ? 'Ephemeral (PXE-booted)' : 'Permanent'}
`;

    if (resources) {
      output += `
Resources to add:
  • CPU: ${resources.cpuCores} cores
  • RAM: ${formatBytes(resources.memoryBytes)}
`;

      if (resources.gpus.length > 0) {
        output += `  • GPU: ${resources.gpus.map(g => g.name).join(', ')}\n`;
      }
    }

    if (node.tags.length > 0) {
      output += `\nTags: ${node.tags.join(', ')}\n`;
    }

    return output;
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
