import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from 'winston';

export interface SecretsConfig {
  logger: Logger;
  secretsDir: string;
  masterKeyEnvVar?: string;
}

export interface Secret {
  name: string;
  value: string;
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
}

export class SecretsManager {
  private config: SecretsConfig;
  private masterKey: Buffer | null = null;
  private secrets: Map<string, Secret> = new Map();
  private loaded = false;

  constructor(config: SecretsConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Get master key from environment or generate
    const envVar = this.config.masterKeyEnvVar ?? 'CLAUDECLUSTER_MASTER_KEY';
    const envKey = process.env[envVar];

    if (envKey) {
      this.masterKey = Buffer.from(envKey, 'hex');
    } else {
      // Try to load from file or generate new
      const keyPath = path.join(this.config.secretsDir, '.master-key');
      try {
        this.masterKey = await fs.readFile(keyPath);
        this.config.logger.info('Loaded master key from file');
      } catch {
        this.masterKey = crypto.randomBytes(32);
        await fs.mkdir(this.config.secretsDir, { recursive: true });
        await fs.writeFile(keyPath, this.masterKey, { mode: 0o600 });
        this.config.logger.info('Generated new master key');
      }
    }

    await this.loadSecrets();
  }

  private async loadSecrets(): Promise<void> {
    const secretsFile = path.join(this.config.secretsDir, 'secrets.json');

    try {
      const data = await fs.readFile(secretsFile, 'utf-8');
      const stored = JSON.parse(data) as Record<string, Secret>;

      for (const [name, secret] of Object.entries(stored)) {
        if (secret.encrypted && this.masterKey) {
          secret.value = this.decrypt(secret.value);
        }
        this.secrets.set(name, secret);
      }

      this.config.logger.info('Loaded secrets', { count: this.secrets.size });
    } catch {
      this.config.logger.info('No existing secrets file');
    }

    this.loaded = true;
  }

  private async saveSecrets(): Promise<void> {
    const secretsFile = path.join(this.config.secretsDir, 'secrets.json');
    const toStore: Record<string, Secret> = {};

    for (const [name, secret] of this.secrets) {
      toStore[name] = {
        ...secret,
        value: this.masterKey ? this.encrypt(secret.value) : secret.value,
        encrypted: !!this.masterKey,
      };
    }

    await fs.mkdir(this.config.secretsDir, { recursive: true });
    await fs.writeFile(secretsFile, JSON.stringify(toStore, null, 2), { mode: 0o600 });
  }

  // Set a secret
  async set(name: string, value: string): Promise<void> {
    const now = Date.now();
    const existing = this.secrets.get(name);

    this.secrets.set(name, {
      name,
      value,
      encrypted: !!this.masterKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    await this.saveSecrets();
    this.config.logger.info('Secret set', { name });
  }

  // Get a secret
  get(name: string): string | undefined {
    return this.secrets.get(name)?.value;
  }

  // Delete a secret
  async delete(name: string): Promise<boolean> {
    if (this.secrets.delete(name)) {
      await this.saveSecrets();
      this.config.logger.info('Secret deleted', { name });
      return true;
    }
    return false;
  }

  // List secret names (not values)
  list(): string[] {
    return Array.from(this.secrets.keys());
  }

  // Check if a secret exists
  has(name: string): boolean {
    return this.secrets.has(name);
  }

  // Encrypt a value
  private encrypt(plaintext: string): string {
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  // Decrypt a value
  private decrypt(ciphertext: string): string {
    if (!this.masterKey) {
      throw new Error('Master key not initialized');
    }

    const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  // Generate a random secret value
  static generateSecret(length: number = 32): string {
    return crypto.randomBytes(length).toString('hex');
  }

  // Hash a value (for storing non-reversible secrets like passwords)
  static hash(value: string, salt?: string): { hash: string; salt: string } {
    const useSalt = salt ?? crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(value, useSalt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt: useSalt };
  }

  // Verify a hash
  static verifyHash(value: string, hash: string, salt: string): boolean {
    const computed = crypto.pbkdf2Sync(value, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
  }
}

// Environment variable injection for tasks
export class EnvInjector {
  private secretsManager: SecretsManager;
  private config: { logger: Logger };

  constructor(secretsManager: SecretsManager, config: { logger: Logger }) {
    this.secretsManager = secretsManager;
    this.config = config;
  }

  // Inject secrets into environment variables
  // Supports ${SECRET_NAME} syntax in values
  injectSecrets(env: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      result[key] = this.interpolate(value);
    }

    return result;
  }

  private interpolate(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (match, secretName) => {
      const secret = this.secretsManager.get(secretName);
      if (secret === undefined) {
        this.config.logger.warn('Secret not found for interpolation', { secretName });
        return match; // Keep original if not found
      }
      return secret;
    });
  }

  // Get all secrets as environment variables with a prefix
  getSecretsAsEnv(prefix: string = 'SECRET_'): Record<string, string> {
    const result: Record<string, string> = {};

    for (const name of this.secretsManager.list()) {
      const value = this.secretsManager.get(name);
      if (value) {
        result[`${prefix}${name.toUpperCase()}`] = value;
      }
    }

    return result;
  }
}
