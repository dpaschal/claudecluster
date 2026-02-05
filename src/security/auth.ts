import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from 'winston';

export interface AuthConfig {
  logger: Logger;
  certsDir: string;
  clusterSecret?: string;
}

export interface NodeCredentials {
  nodeId: string;
  certificate: Buffer;
  privateKey: Buffer;
  caCertificate: Buffer;
}

export interface AuthToken {
  nodeId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export class AuthManager {
  private config: AuthConfig;
  private clusterSecret: Buffer;
  private tokens: Map<string, AuthToken> = new Map();

  constructor(config: AuthConfig) {
    this.config = config;
    // Use provided secret or generate from environment
    this.clusterSecret = config.clusterSecret
      ? Buffer.from(config.clusterSecret)
      : crypto.randomBytes(32);
  }

  // Generate a join token for new nodes
  generateJoinToken(nodeId: string, validityMs: number = 3600000): string {
    const now = Date.now();
    const token: AuthToken = {
      nodeId,
      issuedAt: now,
      expiresAt: now + validityMs,
      signature: '',
    };

    // Create signature
    const data = `${nodeId}:${token.issuedAt}:${token.expiresAt}`;
    token.signature = crypto
      .createHmac('sha256', this.clusterSecret)
      .update(data)
      .digest('hex');

    this.tokens.set(nodeId, token);

    // Encode as base64 JSON
    return Buffer.from(JSON.stringify(token)).toString('base64');
  }

  // Validate a join token
  validateJoinToken(tokenStr: string): { valid: boolean; nodeId?: string; reason?: string } {
    try {
      const token: AuthToken = JSON.parse(Buffer.from(tokenStr, 'base64').toString());

      // Check expiry
      if (Date.now() > token.expiresAt) {
        return { valid: false, reason: 'Token expired' };
      }

      // Verify signature
      const data = `${token.nodeId}:${token.issuedAt}:${token.expiresAt}`;
      const expectedSignature = crypto
        .createHmac('sha256', this.clusterSecret)
        .update(data)
        .digest('hex');

      if (token.signature !== expectedSignature) {
        return { valid: false, reason: 'Invalid signature' };
      }

      return { valid: true, nodeId: token.nodeId };
    } catch {
      return { valid: false, reason: 'Invalid token format' };
    }
  }

  // Generate self-signed CA certificate
  async generateCA(): Promise<{ cert: Buffer; key: Buffer }> {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
    });

    // Note: In production, use a proper X.509 library like node-forge
    // This is a simplified placeholder
    const caCert = this.createSelfSignedCert(privateKey, publicKey, 'ClaudeCluster CA', true);

    const certPem = this.keyToPem(publicKey, 'PUBLIC KEY');
    const keyPem = this.keyToPem(privateKey, 'PRIVATE KEY');

    // Save to disk
    const caDir = path.join(this.config.certsDir, 'ca');
    await fs.mkdir(caDir, { recursive: true });
    await fs.writeFile(path.join(caDir, 'ca.crt'), certPem);
    await fs.writeFile(path.join(caDir, 'ca.key'), keyPem, { mode: 0o600 });

    this.config.logger.info('Generated CA certificate');

    return { cert: certPem, key: keyPem };
  }

  // Generate node certificate signed by CA
  async generateNodeCertificate(
    nodeId: string,
    hostname: string,
    ips: string[]
  ): Promise<NodeCredentials> {
    // Load CA
    const caDir = path.join(this.config.certsDir, 'ca');
    const caCert = await fs.readFile(path.join(caDir, 'ca.crt'));
    const caKey = await fs.readFile(path.join(caDir, 'ca.key'));

    // Generate node keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    // Create certificate (simplified - use proper X.509 in production)
    const nodeCert = this.createSelfSignedCert(
      privateKey,
      publicKey,
      `node:${nodeId}:${hostname}`,
      false
    );

    const certPem = this.keyToPem(publicKey, 'PUBLIC KEY');
    const keyPem = this.keyToPem(privateKey, 'PRIVATE KEY');

    // Save to disk
    const nodeDir = path.join(this.config.certsDir, 'nodes', nodeId);
    await fs.mkdir(nodeDir, { recursive: true });
    await fs.writeFile(path.join(nodeDir, 'node.crt'), certPem);
    await fs.writeFile(path.join(nodeDir, 'node.key'), keyPem, { mode: 0o600 });

    this.config.logger.info('Generated node certificate', { nodeId, hostname });

    return {
      nodeId,
      certificate: certPem,
      privateKey: keyPem,
      caCertificate: caCert,
    };
  }

  // Load existing node credentials
  async loadNodeCredentials(nodeId: string): Promise<NodeCredentials | null> {
    try {
      const nodeDir = path.join(this.config.certsDir, 'nodes', nodeId);
      const caDir = path.join(this.config.certsDir, 'ca');

      const [certificate, privateKey, caCertificate] = await Promise.all([
        fs.readFile(path.join(nodeDir, 'node.crt')),
        fs.readFile(path.join(nodeDir, 'node.key')),
        fs.readFile(path.join(caDir, 'ca.crt')),
      ]);

      return { nodeId, certificate, privateKey, caCertificate };
    } catch {
      return null;
    }
  }

  // Verify peer certificate
  verifyPeerCertificate(cert: Buffer, expectedNodeId?: string): boolean {
    // In production, properly verify the certificate chain and CN/SAN
    // This is a simplified placeholder
    try {
      const certStr = cert.toString();
      if (expectedNodeId && !certStr.includes(expectedNodeId)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Helper to create a simplified self-signed cert (placeholder)
  private createSelfSignedCert(
    _privateKey: crypto.KeyObject,
    _publicKey: crypto.KeyObject,
    cn: string,
    isCA: boolean
  ): string {
    // In production, use node-forge or similar to create proper X.509 certificates
    // This returns a placeholder for the structure
    return JSON.stringify({
      type: isCA ? 'CA' : 'END_ENTITY',
      cn,
      notBefore: new Date().toISOString(),
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  // Helper to convert key to PEM format
  private keyToPem(key: crypto.KeyObject, type: string): Buffer {
    return Buffer.from(key.export({
      type: type === 'PRIVATE KEY' ? 'pkcs8' : 'spki',
      format: 'pem',
    }));
  }
}

// Authorization policies
export interface AuthzPolicy {
  name: string;
  subjects: string[];  // Node IDs or patterns
  actions: string[];   // Allowed actions
  resources: string[]; // Resource patterns
}

export class AuthzManager {
  private policies: AuthzPolicy[] = [];
  private config: { logger: Logger };

  constructor(config: { logger: Logger }) {
    this.config = config;
    this.loadDefaultPolicies();
  }

  private loadDefaultPolicies(): void {
    // Default policy: all nodes can read cluster state
    this.policies.push({
      name: 'cluster-read',
      subjects: ['*'],
      actions: ['read'],
      resources: ['cluster:state', 'cluster:nodes', 'cluster:sessions'],
    });

    // Default policy: nodes can submit tasks
    this.policies.push({
      name: 'task-submit',
      subjects: ['*'],
      actions: ['submit'],
      resources: ['task:*'],
    });

    // Default policy: leader-only actions
    this.policies.push({
      name: 'leader-only',
      subjects: ['role:leader'],
      actions: ['approve', 'remove', 'scale'],
      resources: ['node:*', 'cluster:*'],
    });
  }

  addPolicy(policy: AuthzPolicy): void {
    this.policies.push(policy);
    this.config.logger.info('Added authorization policy', { name: policy.name });
  }

  removePolicy(name: string): boolean {
    const index = this.policies.findIndex(p => p.name === name);
    if (index >= 0) {
      this.policies.splice(index, 1);
      return true;
    }
    return false;
  }

  // Check if a subject is authorized for an action on a resource
  isAuthorized(subject: string, action: string, resource: string, context?: { role?: string }): boolean {
    for (const policy of this.policies) {
      // Check if subject matches
      const subjectMatch = policy.subjects.some(s => {
        if (s === '*') return true;
        if (s.startsWith('role:') && context?.role === s.slice(5)) return true;
        return s === subject;
      });

      if (!subjectMatch) continue;

      // Check if action matches
      const actionMatch = policy.actions.includes(action) || policy.actions.includes('*');
      if (!actionMatch) continue;

      // Check if resource matches
      const resourceMatch = policy.resources.some(r => {
        if (r === '*') return true;
        if (r.endsWith(':*')) {
          const prefix = r.slice(0, -1);
          return resource.startsWith(prefix);
        }
        return r === resource;
      });

      if (resourceMatch) {
        return true;
      }
    }

    this.config.logger.debug('Authorization denied', { subject, action, resource });
    return false;
  }
}
