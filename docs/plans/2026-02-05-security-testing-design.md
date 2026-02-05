# Security Testing Design

## Goal

Add comprehensive unit tests for AuthManager, AuthzManager, and SecretsManager.

## Scope

**In scope:**
- Unit tests for AuthManager (token generation, certificate generation)
- Unit tests for AuthzManager (policy management, authorization checks)
- Unit tests for SecretsManager (encryption, storage, injection)
- Mock crypto operations where needed

**Out of scope:**
- Integration tests with gRPC (separate plan)
- Multi-node security tests (separate plan)
- Real certificate validation

## Test Structure

**File:** `tests/security.test.ts`

```
describe('Security')
  describe('AuthManager')
    describe('Token Management')       - 4 tests
    describe('Certificate Generation') - 4 tests
    describe('Peer Verification')      - 2 tests
  describe('AuthzManager')
    describe('Policy Management')      - 4 tests
    describe('Authorization Checks')   - 5 tests
  describe('SecretsManager')
    describe('Encryption')             - 3 tests
    describe('Storage')                - 4 tests
    describe('Environment Injection')  - 3 tests
```

**Total: 29 tests**

## Test Cases

### AuthManager - Token Management (4 tests)
1. Should generate valid join token with signature
2. Should validate unexpired token successfully
3. Should reject expired token
4. Should reject tampered token

### AuthManager - Certificate Generation (4 tests)
1. Should generate CA certificate
2. Should generate node certificate signed by CA
3. Should load existing credentials from disk
4. Should create credentials directory if missing

### AuthManager - Peer Verification (2 tests)
1. Should verify valid peer certificate
2. Should reject invalid peer certificate

### AuthzManager - Policy Management (4 tests)
1. Should add policy successfully
2. Should remove policy by name
3. Should load default policies on init
4. Should list all policies

### AuthzManager - Authorization Checks (5 tests)
1. Should authorize matching subject-action-resource
2. Should deny non-matching policy
3. Should support wildcard subjects
4. Should support wildcard actions
5. Should support role-based subjects

### SecretsManager - Encryption (3 tests)
1. Should encrypt and decrypt round-trip
2. Should produce different ciphertext for same plaintext (IV)
3. Should reject tampered ciphertext

### SecretsManager - Storage (4 tests)
1. Should store and retrieve secret
2. Should list secret names without values
3. Should delete secret
4. Should generate master key if missing

### SecretsManager - Environment Injection (3 tests)
1. Should interpolate ${SECRET_NAME} in env vars
2. Should leave non-secret vars unchanged
3. Should export secrets as prefixed env variables

## Success Criteria

- All 29 tests pass
- No regressions in existing tests
- Full coverage of security module public APIs
