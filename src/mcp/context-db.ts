// src/mcp/context-db.ts
import pg from 'pg';

const { Pool } = pg;

export type ContextCategory = 'project' | 'pr' | 'machine' | 'waiting' | 'fact';

export interface ContextEntry {
  key: string;
  value: Record<string, unknown>;
  thread_id: number | null;
  category: ContextCategory;
  label: string | null;
  source: string | null;
  pinned: boolean;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SetContextParams {
  key: string;
  value: Record<string, unknown>;
  category: ContextCategory;
  label?: string;
  thread_id?: number;
  source?: string;
  pinned?: boolean;
  expires_at?: Date;
}

export interface ListContextParams {
  category?: ContextCategory;
  thread_id?: number;
  pinned_only?: boolean;
  since_days?: number;
  limit?: number;
}

export class ContextDB {
  private pool: pg.Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString: connectionString ?? 'postgresql://cerebrus:cerebrus2025@100.69.42.106:5432/cerebrus',
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async set(params: SetContextParams): Promise<ContextEntry> {
    const result = await this.pool.query<ContextEntry>(
      `INSERT INTO timeline.context (key, value, category, label, thread_id, source, pinned, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         category = EXCLUDED.category,
         label = COALESCE(EXCLUDED.label, timeline.context.label),
         thread_id = COALESCE(EXCLUDED.thread_id, timeline.context.thread_id),
         source = EXCLUDED.source,
         pinned = COALESCE(EXCLUDED.pinned, timeline.context.pinned),
         expires_at = COALESCE(EXCLUDED.expires_at, timeline.context.expires_at),
         updated_at = NOW()
       RETURNING *`,
      [
        params.key,
        JSON.stringify(params.value),
        params.category,
        params.label ?? null,
        params.thread_id ?? null,
        params.source ?? null,
        params.pinned ?? false,
        params.expires_at ?? null,
      ]
    );
    return result.rows[0];
  }

  async get(key: string): Promise<ContextEntry | null> {
    const result = await this.pool.query<ContextEntry>(
      'SELECT * FROM timeline.context WHERE key = $1',
      [key]
    );
    return result.rows[0] ?? null;
  }

  async list(params: ListContextParams): Promise<ContextEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    // Default: entries updated within last 7 days OR pinned
    const sinceDays = params.since_days ?? 7;
    conditions.push(`(updated_at > NOW() - INTERVAL '${sinceDays} days' OR pinned = TRUE)`);

    if (params.category) {
      conditions.push(`category = $${paramIdx++}`);
      values.push(params.category);
    }

    if (params.thread_id !== undefined) {
      conditions.push(`thread_id = $${paramIdx++}`);
      values.push(params.thread_id);
    }

    if (params.pinned_only) {
      conditions.push('pinned = TRUE');
    }

    const limit = params.limit ?? 50;

    const query = `
      SELECT * FROM timeline.context
      WHERE ${conditions.join(' AND ')}
      ORDER BY pinned DESC, updated_at DESC
      LIMIT ${limit}
    `;

    const result = await this.pool.query<ContextEntry>(query, values);
    return result.rows;
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM timeline.context WHERE key = $1',
      [key]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM timeline.context WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );
    return result.rowCount ?? 0;
  }
}
