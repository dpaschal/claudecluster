import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AuthManager, AuthConfig, AuthToken, AuthzManager, AuthzPolicy } from '../src/security/auth';
import { SecretsManager, EnvInjector } from '../src/security/secrets';
import { Logger } from 'winston';
import * as fs from 'fs/promises';

// Mock fs/promises module
vi.mock('fs/promises');

// Create a mock logger for testing
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger);

describe('AuthManager', () => {
  let authManager: AuthManager;
  const testSecret = 'test-cluster-secret-for-testing';
  const testCertsDir = '/tmp/test-certs';

  beforeEach(() => {
    vi.clearAllMocks();
    const config: AuthConfig = {
      logger: createMockLogger(),
      certsDir: testCertsDir,
      clusterSecret: testSecret,
    };
    authManager = new AuthManager(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Token Generation', () => {
    it('should generate valid join token with signature', () => {
      const nodeId = 'test-node-1';
      const tokenStr = authManager.generateJoinToken(nodeId);

      // Token should be a non-empty string
      expect(tokenStr).toBeDefined();
      expect(typeof tokenStr).toBe('string');
      expect(tokenStr.length).toBeGreaterThan(0);

      // Decode the token and verify structure
      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;

      // Token should contain required fields
      expect(decoded.nodeId).toBe(nodeId);
      expect(decoded.issuedAt).toBeDefined();
      expect(typeof decoded.issuedAt).toBe('number');
      expect(decoded.expiresAt).toBeDefined();
      expect(typeof decoded.expiresAt).toBe('number');
      expect(decoded.signature).toBeDefined();
      expect(typeof decoded.signature).toBe('string');
      expect(decoded.signature.length).toBeGreaterThan(0);

      // Signature should be a hex string (HMAC-SHA256 produces 64 hex characters)
      expect(decoded.signature).toMatch(/^[a-f0-9]{64}$/);

      // expiresAt should be after issuedAt
      expect(decoded.expiresAt).toBeGreaterThan(decoded.issuedAt);
    });

    it('should generate token with custom validity period', () => {
      const nodeId = 'test-node-2';
      const validityMs = 60000; // 1 minute
      const tokenStr = authManager.generateJoinToken(nodeId, validityMs);

      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;

      // Check that validity period is approximately correct (within 100ms tolerance)
      const actualValidity = decoded.expiresAt - decoded.issuedAt;
      expect(actualValidity).toBe(validityMs);
    });
  });

  describe('Token Validation', () => {
    it('should validate unexpired token successfully', () => {
      const nodeId = 'valid-node';
      const tokenStr = authManager.generateJoinToken(nodeId);

      const result = authManager.validateJoinToken(tokenStr);

      expect(result.valid).toBe(true);
      expect(result.nodeId).toBe(nodeId);
      expect(result.reason).toBeUndefined();
    });

    it('should reject expired token', () => {
      const nodeId = 'expired-node';
      // Generate token with 1ms validity (will expire immediately)
      const tokenStr = authManager.generateJoinToken(nodeId, 1);

      // Wait a small amount to ensure token expires
      const startTime = Date.now();
      while (Date.now() - startTime < 10) {
        // Busy wait to ensure token expires
      }

      const result = authManager.validateJoinToken(tokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token expired');
      expect(result.nodeId).toBeUndefined();
    });

    it('should reject tampered token', () => {
      const nodeId = 'tampered-node';
      const tokenStr = authManager.generateJoinToken(nodeId);

      // Decode, tamper, and re-encode the token
      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;

      // Tamper with the nodeId
      decoded.nodeId = 'malicious-node';

      // Re-encode without updating signature
      const tamperedTokenStr = Buffer.from(JSON.stringify(decoded)).toString('base64');

      const result = authManager.validateJoinToken(tamperedTokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject token with tampered expiry', () => {
      const nodeId = 'expiry-tampered-node';
      const tokenStr = authManager.generateJoinToken(nodeId, 1000);

      // Decode and extend expiry without updating signature
      const decoded = JSON.parse(Buffer.from(tokenStr, 'base64').toString()) as AuthToken;
      decoded.expiresAt = Date.now() + 999999999; // Extend expiry

      const tamperedTokenStr = Buffer.from(JSON.stringify(decoded)).toString('base64');

      const result = authManager.validateJoinToken(tamperedTokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });

    it('should reject invalid base64 token', () => {
      const result = authManager.validateJoinToken('not-valid-base64!!!');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid token format');
    });

    it('should reject malformed JSON token', () => {
      const invalidJson = Buffer.from('{ invalid json }').toString('base64');

      const result = authManager.validateJoinToken(invalidJson);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid token format');
    });
  });

  describe('Token Isolation', () => {
    it('should not validate token from different AuthManager instance', () => {
      // Create two AuthManagers with different secrets
      const authManager1 = new AuthManager({
        logger: createMockLogger(),
        certsDir: '/tmp/test-certs-1',
        clusterSecret: 'secret-cluster-1',
      });

      const authManager2 = new AuthManager({
        logger: createMockLogger(),
        certsDir: '/tmp/test-certs-2',
        clusterSecret: 'secret-cluster-2',
      });

      const nodeId = 'cross-cluster-node';
      const tokenStr = authManager1.generateJoinToken(nodeId);

      // Token from authManager1 should not validate on authManager2
      const result = authManager2.validateJoinToken(tokenStr);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Invalid signature');
    });
  });

  describe('Certificate Generation', () => {
    it('should generate CA certificate', async () => {
      // Mock fs operations for CA generation
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const result = await authManager.generateCA();

      // Verify cert and key are returned as Buffers
      expect(result.cert).toBeInstanceOf(Buffer);
      expect(result.key).toBeInstanceOf(Buffer);
      expect(result.cert.length).toBeGreaterThan(0);
      expect(result.key.length).toBeGreaterThan(0);

      // Verify directory was created
      expect(fs.mkdir).toHaveBeenCalledWith(
        `${testCertsDir}/ca`,
        { recursive: true }
      );

      // Verify files were written
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/ca/ca.crt`,
        expect.any(Buffer)
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/ca/ca.key`,
        expect.any(Buffer),
        { mode: 0o600 }
      );
    });

    it('should generate node certificate', async () => {
      // Mock CA files exist
      const mockCaCert = Buffer.from('mock-ca-cert');
      const mockCaKey = Buffer.from('mock-ca-key');

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        const pathStr = path.toString();
        if (pathStr.endsWith('ca.crt')) return mockCaCert;
        if (pathStr.endsWith('ca.key')) return mockCaKey;
        throw new Error(`Unexpected path: ${pathStr}`);
      });
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const nodeId = 'test-node-1';
      const hostname = 'test-host';
      const ips = ['192.168.1.1', '10.0.0.1'];

      const result = await authManager.generateNodeCertificate(nodeId, hostname, ips);

      // Verify NodeCredentials structure
      expect(result.nodeId).toBe(nodeId);
      expect(result.certificate).toBeInstanceOf(Buffer);
      expect(result.privateKey).toBeInstanceOf(Buffer);
      expect(result.caCertificate).toEqual(mockCaCert);

      // Verify node directory was created
      expect(fs.mkdir).toHaveBeenCalledWith(
        `${testCertsDir}/nodes/${nodeId}`,
        { recursive: true }
      );

      // Verify node cert and key were written
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/nodes/${nodeId}/node.crt`,
        expect.any(Buffer)
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        `${testCertsDir}/nodes/${nodeId}/node.key`,
        expect.any(Buffer),
        { mode: 0o600 }
      );
    });

    it('should load existing credentials from disk', async () => {
      const nodeId = 'existing-node';
      const mockCert = Buffer.from('mock-node-cert');
      const mockKey = Buffer.from('mock-node-key');
      const mockCaCert = Buffer.from('mock-ca-cert');

      vi.mocked(fs.readFile).mockImplementation(async (path) => {
        const pathStr = path.toString();
        if (pathStr.endsWith('node.crt')) return mockCert;
        if (pathStr.endsWith('node.key')) return mockKey;
        if (pathStr.endsWith('ca.crt')) return mockCaCert;
        throw new Error(`Unexpected path: ${pathStr}`);
      });

      const result = await authManager.loadNodeCredentials(nodeId);

      expect(result).not.toBeNull();
      expect(result!.nodeId).toBe(nodeId);
      expect(result!.certificate).toEqual(mockCert);
      expect(result!.privateKey).toEqual(mockKey);
      expect(result!.caCertificate).toEqual(mockCaCert);

      // Verify correct paths were read
      expect(fs.readFile).toHaveBeenCalledWith(`${testCertsDir}/nodes/${nodeId}/node.crt`);
      expect(fs.readFile).toHaveBeenCalledWith(`${testCertsDir}/nodes/${nodeId}/node.key`);
      expect(fs.readFile).toHaveBeenCalledWith(`${testCertsDir}/ca/ca.crt`);
    });

    it('should create credentials directory if missing', async () => {
      // This test verifies mkdir is called with recursive: true
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await authManager.generateCA();

      // Verify mkdir was called with recursive option to create nested directories
      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('ca'),
        { recursive: true }
      );
    });
  });

  describe('Peer Verification', () => {
    it('should verify valid peer certificate', () => {
      // Create a certificate buffer that includes the expected nodeId
      const nodeId = 'verified-node';
      const certContent = JSON.stringify({
        type: 'END_ENTITY',
        cn: `node:${nodeId}:hostname`,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const cert = Buffer.from(certContent);

      // Verify without expectedNodeId
      const resultWithoutExpected = authManager.verifyPeerCertificate(cert);
      expect(resultWithoutExpected).toBe(true);

      // Verify with matching expectedNodeId
      const resultWithExpected = authManager.verifyPeerCertificate(cert, nodeId);
      expect(resultWithExpected).toBe(true);
    });

    it('should reject certificate with wrong nodeId', () => {
      // Create a certificate with one nodeId
      const actualNodeId = 'actual-node';
      const certContent = JSON.stringify({
        type: 'END_ENTITY',
        cn: `node:${actualNodeId}:hostname`,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const cert = Buffer.from(certContent);

      // Try to verify with a different expectedNodeId
      const wrongNodeId = 'wrong-node';
      const result = authManager.verifyPeerCertificate(cert, wrongNodeId);

      expect(result).toBe(false);
    });
  });
});

describe('AuthzManager', () => {
  let authzManager: AuthzManager;

  beforeEach(() => {
    vi.clearAllMocks();
    authzManager = new AuthzManager({
      logger: createMockLogger(),
    });
  });

  describe('Policy Management', () => {
    it('should add policy successfully', () => {
      const customPolicy: AuthzPolicy = {
        name: 'custom-policy',
        subjects: ['node-1'],
        actions: ['execute'],
        resources: ['task:custom'],
      };

      authzManager.addPolicy(customPolicy);

      // Verify the policy works by checking authorization
      expect(authzManager.isAuthorized('node-1', 'execute', 'task:custom')).toBe(true);
      // Should not authorize different subject
      expect(authzManager.isAuthorized('node-2', 'execute', 'task:custom')).toBe(false);
    });

    it('should remove policy by name', () => {
      const customPolicy: AuthzPolicy = {
        name: 'removable-policy',
        subjects: ['node-1'],
        actions: ['delete'],
        resources: ['resource:test'],
      };

      authzManager.addPolicy(customPolicy);

      // Verify policy is active
      expect(authzManager.isAuthorized('node-1', 'delete', 'resource:test')).toBe(true);

      // Remove the policy
      const removed = authzManager.removePolicy('removable-policy');
      expect(removed).toBe(true);

      // Verify policy no longer authorizes
      expect(authzManager.isAuthorized('node-1', 'delete', 'resource:test')).toBe(false);
    });

    it('should load default policies on init', () => {
      // Test cluster-read default policy: all nodes can read cluster:state
      expect(authzManager.isAuthorized('any-node', 'read', 'cluster:state')).toBe(true);
      expect(authzManager.isAuthorized('any-node', 'read', 'cluster:nodes')).toBe(true);
      expect(authzManager.isAuthorized('any-node', 'read', 'cluster:sessions')).toBe(true);

      // Test task-submit default policy: all nodes can submit tasks
      expect(authzManager.isAuthorized('any-node', 'submit', 'task:123')).toBe(true);
      expect(authzManager.isAuthorized('any-node', 'submit', 'task:any-task')).toBe(true);
    });

    it('should allow adding multiple policies', () => {
      const policy1: AuthzPolicy = {
        name: 'policy-1',
        subjects: ['node-a'],
        actions: ['action-1'],
        resources: ['resource:1'],
      };

      const policy2: AuthzPolicy = {
        name: 'policy-2',
        subjects: ['node-b'],
        actions: ['action-2'],
        resources: ['resource:2'],
      };

      authzManager.addPolicy(policy1);
      authzManager.addPolicy(policy2);

      // Verify both policies work
      expect(authzManager.isAuthorized('node-a', 'action-1', 'resource:1')).toBe(true);
      expect(authzManager.isAuthorized('node-b', 'action-2', 'resource:2')).toBe(true);

      // Cross-check: node-a should not have node-b's permissions
      expect(authzManager.isAuthorized('node-a', 'action-2', 'resource:2')).toBe(false);
      expect(authzManager.isAuthorized('node-b', 'action-1', 'resource:1')).toBe(false);
    });
  });

  describe('Authorization Checks', () => {
    it('should authorize matching subject-action-resource', () => {
      const policy: AuthzPolicy = {
        name: 'exact-match-policy',
        subjects: ['specific-node'],
        actions: ['specific-action'],
        resources: ['specific:resource'],
      };

      authzManager.addPolicy(policy);

      expect(authzManager.isAuthorized('specific-node', 'specific-action', 'specific:resource')).toBe(true);
    });

    it('should deny non-matching policy', () => {
      // Without adding any custom policy, try to access a resource not covered by defaults
      expect(authzManager.isAuthorized('any-node', 'write', 'cluster:state')).toBe(false);
      expect(authzManager.isAuthorized('any-node', 'delete', 'task:123')).toBe(false);
      expect(authzManager.isAuthorized('any-node', 'approve', 'node:worker')).toBe(false);
    });

    it('should support wildcard subjects (*)', () => {
      // The default 'cluster-read' policy uses wildcard subject '*'
      // Any subject should be able to read cluster:state
      expect(authzManager.isAuthorized('node-1', 'read', 'cluster:state')).toBe(true);
      expect(authzManager.isAuthorized('node-2', 'read', 'cluster:state')).toBe(true);
      expect(authzManager.isAuthorized('random-node', 'read', 'cluster:state')).toBe(true);
    });

    it('should support wildcard actions (*)', () => {
      const wildcardActionPolicy: AuthzPolicy = {
        name: 'wildcard-action-policy',
        subjects: ['admin-node'],
        actions: ['*'],
        resources: ['admin:panel'],
      };

      authzManager.addPolicy(wildcardActionPolicy);

      // Any action should be allowed for admin-node on admin:panel
      expect(authzManager.isAuthorized('admin-node', 'read', 'admin:panel')).toBe(true);
      expect(authzManager.isAuthorized('admin-node', 'write', 'admin:panel')).toBe(true);
      expect(authzManager.isAuthorized('admin-node', 'delete', 'admin:panel')).toBe(true);
      expect(authzManager.isAuthorized('admin-node', 'execute', 'admin:panel')).toBe(true);

      // But other nodes should not have access
      expect(authzManager.isAuthorized('other-node', 'read', 'admin:panel')).toBe(false);
    });

    it('should support role-based subjects (role:leader with context)', () => {
      // The default 'leader-only' policy uses 'role:leader' subject
      // Should authorize when context.role matches 'leader'
      expect(authzManager.isAuthorized('any-node', 'approve', 'node:worker', { role: 'leader' })).toBe(true);
      expect(authzManager.isAuthorized('any-node', 'remove', 'node:worker', { role: 'leader' })).toBe(true);
      expect(authzManager.isAuthorized('any-node', 'scale', 'cluster:workers', { role: 'leader' })).toBe(true);

      // Should deny when context.role is not 'leader'
      expect(authzManager.isAuthorized('any-node', 'approve', 'node:worker', { role: 'follower' })).toBe(false);
      expect(authzManager.isAuthorized('any-node', 'approve', 'node:worker', { role: 'worker' })).toBe(false);

      // Should deny when no context is provided
      expect(authzManager.isAuthorized('any-node', 'approve', 'node:worker')).toBe(false);
    });
  });
});

describe('SecretsManager', () => {
  const testSecretsDir = '/tmp/test-secrets';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Static Utilities', () => {
    it('should generate random secret of specified length', () => {
      const secret16 = SecretsManager.generateSecret(16);
      const secret32 = SecretsManager.generateSecret(32);
      const secretDefault = SecretsManager.generateSecret();

      // Hex encoding doubles the length
      expect(secret16).toHaveLength(32);
      expect(secret32).toHaveLength(64);
      expect(secretDefault).toHaveLength(64); // Default is 32 bytes = 64 hex chars

      // Should be valid hex strings
      expect(secret16).toMatch(/^[a-f0-9]+$/);
      expect(secret32).toMatch(/^[a-f0-9]+$/);
      expect(secretDefault).toMatch(/^[a-f0-9]+$/);

      // Each call should generate different values
      const anotherSecret = SecretsManager.generateSecret(32);
      expect(anotherSecret).not.toBe(secret32);
    });

    it('should hash and verify password correctly', () => {
      const password = 'my-secure-password-123';

      // Hash the password
      const { hash, salt } = SecretsManager.hash(password);

      // Hash and salt should be non-empty hex strings
      expect(hash).toMatch(/^[a-f0-9]+$/);
      expect(salt).toMatch(/^[a-f0-9]+$/);
      expect(hash.length).toBeGreaterThan(0);
      expect(salt.length).toBeGreaterThan(0);

      // Verification should succeed with correct password
      const isValid = SecretsManager.verifyHash(password, hash, salt);
      expect(isValid).toBe(true);

      // Using the same salt should produce the same hash
      const { hash: hash2 } = SecretsManager.hash(password, salt);
      expect(hash2).toBe(hash);
    });

    it('should reject incorrect password verification', () => {
      const password = 'correct-password';
      const wrongPassword = 'wrong-password';

      // Hash the correct password
      const { hash, salt } = SecretsManager.hash(password);

      // Verification should fail with wrong password
      const isValid = SecretsManager.verifyHash(wrongPassword, hash, salt);
      expect(isValid).toBe(false);

      // Verification should fail with wrong salt
      const wrongSalt = 'deadbeef12345678';
      const isValidWrongSalt = SecretsManager.verifyHash(password, hash, wrongSalt);
      expect(isValidWrongSalt).toBe(false);
    });
  });

  describe('Secret Storage', () => {
    let secretsManager: SecretsManager;
    const masterKeyHex = 'a'.repeat(64); // 32 bytes in hex

    beforeEach(() => {
      // Set up environment with master key
      process.env.TEST_MASTER_KEY = masterKeyHex;

      secretsManager = new SecretsManager({
        logger: createMockLogger(),
        secretsDir: testSecretsDir,
        masterKeyEnvVar: 'TEST_MASTER_KEY',
      });
    });

    afterEach(() => {
      delete process.env.TEST_MASTER_KEY;
    });

    it('should set and get secret', async () => {
      // Mock fs operations
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await secretsManager.initialize();

      await secretsManager.set('API_KEY', 'my-api-key-value');

      const value = secretsManager.get('API_KEY');
      expect(value).toBe('my-api-key-value');

      // Verify fs.writeFile was called to persist the secret
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should list secret names', async () => {
      // Mock fs operations
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await secretsManager.initialize();

      await secretsManager.set('SECRET_ONE', 'value1');
      await secretsManager.set('SECRET_TWO', 'value2');
      await secretsManager.set('SECRET_THREE', 'value3');

      const names = secretsManager.list();

      expect(names).toContain('SECRET_ONE');
      expect(names).toContain('SECRET_TWO');
      expect(names).toContain('SECRET_THREE');
      expect(names).toHaveLength(3);
    });

    it('should delete secret', async () => {
      // Mock fs operations
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await secretsManager.initialize();

      await secretsManager.set('TO_DELETE', 'some-value');
      expect(secretsManager.get('TO_DELETE')).toBe('some-value');

      const deleted = await secretsManager.delete('TO_DELETE');
      expect(deleted).toBe(true);

      expect(secretsManager.get('TO_DELETE')).toBeUndefined();

      // Deleting non-existent secret should return false
      const deletedAgain = await secretsManager.delete('TO_DELETE');
      expect(deletedAgain).toBe(false);
    });

    it('should check if secret exists', async () => {
      // Mock fs operations
      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      await secretsManager.initialize();

      expect(secretsManager.has('NONEXISTENT')).toBe(false);

      await secretsManager.set('EXISTS', 'value');
      expect(secretsManager.has('EXISTS')).toBe(true);

      await secretsManager.delete('EXISTS');
      expect(secretsManager.has('EXISTS')).toBe(false);
    });
  });
});

describe('EnvInjector', () => {
  const testSecretsDir = '/tmp/test-secrets';
  let secretsManager: SecretsManager;
  let envInjector: EnvInjector;
  const masterKeyHex = 'b'.repeat(64); // 32 bytes in hex

  beforeEach(async () => {
    vi.clearAllMocks();

    // Set up environment with master key
    process.env.TEST_MASTER_KEY_ENV = masterKeyHex;

    // Mock fs operations
    vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    secretsManager = new SecretsManager({
      logger: createMockLogger(),
      secretsDir: testSecretsDir,
      masterKeyEnvVar: 'TEST_MASTER_KEY_ENV',
    });

    await secretsManager.initialize();

    // Set up some secrets for testing
    await secretsManager.set('DB_PASSWORD', 'super-secret-db-pass');
    await secretsManager.set('API_TOKEN', 'token-12345');

    envInjector = new EnvInjector(secretsManager, {
      logger: createMockLogger(),
    });
  });

  afterEach(() => {
    delete process.env.TEST_MASTER_KEY_ENV;
    vi.restoreAllMocks();
  });

  it('should interpolate ${SECRET_NAME} in env vars', () => {
    const inputEnv = {
      DATABASE_URL: 'postgres://user:${DB_PASSWORD}@localhost/mydb',
      AUTH_HEADER: 'Bearer ${API_TOKEN}',
    };

    const result = envInjector.injectSecrets(inputEnv);

    expect(result.DATABASE_URL).toBe('postgres://user:super-secret-db-pass@localhost/mydb');
    expect(result.AUTH_HEADER).toBe('Bearer token-12345');
  });

  it('should leave non-secret vars unchanged', () => {
    const inputEnv = {
      PLAIN_VAR: 'no secrets here',
      ANOTHER_VAR: 'just a regular value',
      PORT: '3000',
      MISSING_SECRET: '${NONEXISTENT_SECRET}', // Secret doesn't exist
    };

    const result = envInjector.injectSecrets(inputEnv);

    expect(result.PLAIN_VAR).toBe('no secrets here');
    expect(result.ANOTHER_VAR).toBe('just a regular value');
    expect(result.PORT).toBe('3000');
    // Non-existent secrets should be left as-is
    expect(result.MISSING_SECRET).toBe('${NONEXISTENT_SECRET}');
  });

  it('should export secrets as prefixed env variables', () => {
    // Test with default prefix
    const resultDefault = envInjector.getSecretsAsEnv();

    expect(resultDefault['SECRET_DB_PASSWORD']).toBe('super-secret-db-pass');
    expect(resultDefault['SECRET_API_TOKEN']).toBe('token-12345');

    // Test with custom prefix
    const resultCustom = envInjector.getSecretsAsEnv('MY_');

    expect(resultCustom['MY_DB_PASSWORD']).toBe('super-secret-db-pass');
    expect(resultCustom['MY_API_TOKEN']).toBe('token-12345');

    // Original keys should not be present with different prefix
    expect(resultCustom['SECRET_DB_PASSWORD']).toBeUndefined();
  });
});
