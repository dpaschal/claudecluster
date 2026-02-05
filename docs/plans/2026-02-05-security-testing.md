# Security Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 29 unit tests for AuthManager, AuthzManager, and SecretsManager.

**Architecture:** Test security modules with mocked filesystem and controlled crypto.

**Tech Stack:** Vitest, vi.mock for fs operations, crypto module

---

## Task 1: Setup and AuthManager Token Tests

**Files:**
- Create: `tests/security.test.ts`

**Step 1: Create test file with setup**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager, AuthzManager } from '../src/security/auth';
import { SecretsManager, EnvInjector } from '../src/security/secrets';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Mock fs for file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    chmodSync: vi.fn(),
  };
});

const createMockLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('Security', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  describe('AuthManager', () => {
    describe('Token Management', () => {
      it('should generate valid join token with signature', () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-cluster-secret',
        });

        const token = auth.generateJoinToken('node-1');

        expect(token).toBeDefined();
        expect(typeof token).toBe('string');
        // Token should have format: base64(payload).signature
        expect(token.split('.').length).toBe(2);
      });

      it('should validate unexpired token successfully', () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-cluster-secret',
        });

        const token = auth.generateJoinToken('node-1', 3600000); // 1 hour
        const result = auth.validateJoinToken(token);

        expect(result.valid).toBe(true);
        expect(result.nodeId).toBe('node-1');
      });

      it('should reject expired token', async () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-cluster-secret',
        });

        // Generate token that expires in 1ms
        const token = auth.generateJoinToken('node-1', 1);

        // Wait for expiration
        await new Promise(r => setTimeout(r, 10));

        const result = auth.validateJoinToken(token);

        expect(result.valid).toBe(false);
        expect(result.reason).toContain('expired');
      });

      it('should reject tampered token', () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-cluster-secret',
        });

        const token = auth.generateJoinToken('node-1');
        // Tamper with the payload
        const parts = token.split('.');
        const tamperedToken = 'tampered' + parts[0].slice(8) + '.' + parts[1];

        const result = auth.validateJoinToken(tamperedToken);

        expect(result.valid).toBe(false);
        expect(result.reason).toContain('signature');
      });
    });
  });
});
```

**Step 2: Run tests**

Run: `npm test -- tests/security.test.ts`
Expected: 4 tests passing

**Step 3: Commit**

```bash
git add tests/security.test.ts
git commit -m "test: add auth token management tests"
```

---

## Task 2: AuthManager Certificate Tests

**Files:**
- Modify: `tests/security.test.ts`

**Step 1: Add certificate generation tests**

```typescript
    describe('Certificate Generation', () => {
      it('should generate CA certificate', async () => {
        (fs.existsSync as any).mockReturnValue(false);

        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-secret',
        });

        const ca = await auth.generateCA();

        expect(ca).toBeDefined();
        expect(ca.cert).toBeDefined();
        expect(ca.key).toBeDefined();
        expect(fs.writeFileSync).toHaveBeenCalled();
      });

      it('should generate node certificate signed by CA', async () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-secret',
        });

        // First generate CA
        const ca = await auth.generateCA();

        // Then generate node cert
        const nodeCert = await auth.generateNodeCertificate('node-1', ca);

        expect(nodeCert).toBeDefined();
        expect(nodeCert.cert).toBeDefined();
        expect(nodeCert.key).toBeDefined();
      });

      it('should load existing credentials from disk', async () => {
        const mockCert = '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----';
        const mockKey = '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----';

        (fs.existsSync as any).mockReturnValue(true);
        (fs.readFileSync as any)
          .mockReturnValueOnce(mockCert)  // cert
          .mockReturnValueOnce(mockKey);   // key

        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-secret',
        });

        const creds = await auth.loadNodeCredentials('node-1');

        expect(creds).toBeDefined();
        expect(fs.readFileSync).toHaveBeenCalled();
      });

      it('should create credentials directory if missing', async () => {
        (fs.existsSync as any).mockReturnValue(false);

        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-secret',
        });

        await auth.generateCA();

        expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/certs', { recursive: true });
      });
    });

    describe('Peer Verification', () => {
      it('should verify valid peer certificate', () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-secret',
        });

        // Mock valid certificate info
        const mockCertInfo = {
          subject: { CN: 'node-1.claudecluster' },
          issuer: { CN: 'claudecluster-ca' },
          valid_from: new Date(Date.now() - 86400000).toISOString(),
          valid_to: new Date(Date.now() + 86400000).toISOString(),
        };

        const result = auth.verifyPeerCertificate(mockCertInfo);

        expect(result.valid).toBe(true);
      });

      it('should reject invalid peer certificate', () => {
        const auth = new AuthManager({
          logger: logger as any,
          certsDir: '/tmp/certs',
          clusterSecret: 'test-secret',
        });

        // Mock expired certificate
        const mockCertInfo = {
          subject: { CN: 'node-1.claudecluster' },
          issuer: { CN: 'claudecluster-ca' },
          valid_from: new Date(Date.now() - 172800000).toISOString(),
          valid_to: new Date(Date.now() - 86400000).toISOString(), // Expired
        };

        const result = auth.verifyPeerCertificate(mockCertInfo);

        expect(result.valid).toBe(false);
      });
    });
```

**Step 2: Run tests**

Run: `npm test -- tests/security.test.ts`
Expected: 10 tests passing

**Step 3: Commit**

```bash
git add tests/security.test.ts
git commit -m "test: add auth certificate and peer verification tests"
```

---

## Task 3: AuthzManager Tests

**Files:**
- Modify: `tests/security.test.ts`

**Step 1: Add authorization manager tests**

```typescript
  describe('AuthzManager', () => {
    describe('Policy Management', () => {
      it('should add policy successfully', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'test-policy',
          subjects: ['node-*'],
          actions: ['read'],
          resources: ['cluster:state'],
        });

        const policies = authz.listPolicies();
        expect(policies.some(p => p.name === 'test-policy')).toBe(true);
      });

      it('should remove policy by name', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'removable-policy',
          subjects: ['*'],
          actions: ['*'],
          resources: ['*'],
        });

        authz.removePolicy('removable-policy');

        const policies = authz.listPolicies();
        expect(policies.some(p => p.name === 'removable-policy')).toBe(false);
      });

      it('should load default policies on init', () => {
        const authz = new AuthzManager({ logger: logger as any });

        const policies = authz.listPolicies();

        // Should have default policies
        expect(policies.length).toBeGreaterThan(0);
        expect(policies.some(p => p.name === 'cluster-read')).toBe(true);
      });

      it('should list all policies', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'policy-1',
          subjects: ['*'],
          actions: ['read'],
          resources: ['*'],
        });
        authz.addPolicy({
          name: 'policy-2',
          subjects: ['*'],
          actions: ['write'],
          resources: ['*'],
        });

        const policies = authz.listPolicies();

        expect(policies.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('Authorization Checks', () => {
      it('should authorize matching subject-action-resource', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'allow-read',
          subjects: ['node-1'],
          actions: ['read'],
          resources: ['cluster:state'],
        });

        const result = authz.isAuthorized('node-1', 'read', 'cluster:state');

        expect(result).toBe(true);
      });

      it('should deny non-matching policy', () => {
        const authz = new AuthzManager({ logger: logger as any });

        // Clear default policies for this test
        const policies = authz.listPolicies();
        policies.forEach(p => authz.removePolicy(p.name));

        authz.addPolicy({
          name: 'specific-policy',
          subjects: ['node-1'],
          actions: ['read'],
          resources: ['specific:resource'],
        });

        const result = authz.isAuthorized('node-2', 'write', 'other:resource');

        expect(result).toBe(false);
      });

      it('should support wildcard subjects', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'wildcard-subject',
          subjects: ['*'],
          actions: ['read'],
          resources: ['public:data'],
        });

        const result = authz.isAuthorized('any-node', 'read', 'public:data');

        expect(result).toBe(true);
      });

      it('should support wildcard actions', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'wildcard-action',
          subjects: ['admin'],
          actions: ['*'],
          resources: ['admin:panel'],
        });

        const result = authz.isAuthorized('admin', 'delete', 'admin:panel');

        expect(result).toBe(true);
      });

      it('should support role-based subjects', () => {
        const authz = new AuthzManager({ logger: logger as any });

        authz.addPolicy({
          name: 'leader-only',
          subjects: ['role:leader'],
          actions: ['manage'],
          resources: ['cluster:config'],
        });

        // Assuming role resolution happens - test the policy exists
        const result = authz.isAuthorized('role:leader', 'manage', 'cluster:config');

        expect(result).toBe(true);
      });
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/security.test.ts`
Expected: 19 tests passing

**Step 3: Commit**

```bash
git add tests/security.test.ts
git commit -m "test: add authorization manager tests"
```

---

## Task 4: SecretsManager Tests

**Files:**
- Modify: `tests/security.test.ts`

**Step 1: Add secrets manager tests**

```typescript
  describe('SecretsManager', () => {
    describe('Encryption', () => {
      it('should encrypt and decrypt round-trip', async () => {
        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        const plaintext = 'my-secret-value';
        const encrypted = secrets.encrypt(plaintext);
        const decrypted = secrets.decrypt(encrypted);

        expect(decrypted).toBe(plaintext);
      });

      it('should produce different ciphertext for same plaintext (IV)', () => {
        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        const plaintext = 'same-secret';
        const encrypted1 = secrets.encrypt(plaintext);
        const encrypted2 = secrets.encrypt(plaintext);

        expect(encrypted1).not.toBe(encrypted2);
        // But both should decrypt to same value
        expect(secrets.decrypt(encrypted1)).toBe(plaintext);
        expect(secrets.decrypt(encrypted2)).toBe(plaintext);
      });

      it('should reject tampered ciphertext', () => {
        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        const encrypted = secrets.encrypt('secret');
        // Tamper with ciphertext
        const tampered = 'tampered' + encrypted.slice(8);

        expect(() => secrets.decrypt(tampered)).toThrow();
      });
    });

    describe('Storage', () => {
      it('should store and retrieve secret', async () => {
        (fs.existsSync as any).mockReturnValue(true);
        let storedData = '';
        (fs.writeFileSync as any).mockImplementation((path: string, data: string) => {
          storedData = data;
        });
        (fs.readFileSync as any).mockImplementation(() => storedData);

        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        await secrets.set('my-secret', 'secret-value');
        const value = await secrets.get('my-secret');

        expect(value).toBe('secret-value');
      });

      it('should list secret names without values', async () => {
        (fs.readdirSync as any).mockReturnValue(['secret1.enc', 'secret2.enc', 'other.txt']);

        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        const names = await secrets.list();

        expect(names).toContain('secret1');
        expect(names).toContain('secret2');
        expect(names).not.toContain('other');
      });

      it('should delete secret', async () => {
        (fs.existsSync as any).mockReturnValue(true);

        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        await secrets.delete('old-secret');

        expect(fs.unlinkSync).toHaveBeenCalled();
      });

      it('should generate master key if missing', async () => {
        (fs.existsSync as any).mockReturnValue(false);
        let generatedKey = '';
        (fs.writeFileSync as any).mockImplementation((path: string, data: string) => {
          if (path.includes('master.key')) {
            generatedKey = data;
          }
        });

        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          // No masterKey provided
        });

        await secrets.initialize();

        expect(generatedKey.length).toBeGreaterThan(0);
      });
    });

    describe('Environment Injection', () => {
      it('should interpolate ${SECRET_NAME} in env vars', async () => {
        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        // Mock secret retrieval
        vi.spyOn(secrets, 'get').mockResolvedValue('db-password-123');

        const injector = new EnvInjector(secrets);
        const env = {
          DATABASE_URL: 'postgres://user:${DB_PASSWORD}@localhost/db',
          OTHER_VAR: 'no-secrets-here',
        };

        const result = await injector.injectSecrets(env);

        expect(result.DATABASE_URL).toBe('postgres://user:db-password-123@localhost/db');
      });

      it('should leave non-secret vars unchanged', async () => {
        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        const injector = new EnvInjector(secrets);
        const env = {
          PATH: '/usr/bin',
          HOME: '/home/user',
        };

        const result = await injector.injectSecrets(env);

        expect(result.PATH).toBe('/usr/bin');
        expect(result.HOME).toBe('/home/user');
      });

      it('should export secrets as prefixed env variables', async () => {
        const secrets = new SecretsManager({
          logger: logger as any,
          secretsDir: '/tmp/secrets',
          masterKey: crypto.randomBytes(32).toString('hex'),
        });

        vi.spyOn(secrets, 'list').mockResolvedValue(['API_KEY', 'DB_PASS']);
        vi.spyOn(secrets, 'get')
          .mockResolvedValueOnce('key-123')
          .mockResolvedValueOnce('pass-456');

        const injector = new EnvInjector(secrets);
        const result = await injector.getSecretsAsEnv('SECRET_');

        expect(result.SECRET_API_KEY).toBe('key-123');
        expect(result.SECRET_DB_PASS).toBe('pass-456');
      });
    });
  });
```

**Step 2: Run tests**

Run: `npm test -- tests/security.test.ts`
Expected: 29 tests passing

**Step 3: Commit**

```bash
git add tests/security.test.ts
git commit -m "test: add secrets manager tests"
```

---

## Task 5: Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests passing

**Step 2: Verify test count**

Run: `grep -c "it\(" tests/security.test.ts`
Expected: 29

**Step 3: Final commit**

```bash
git add -A
git commit -m "test: security tests complete (29 tests)"
```
