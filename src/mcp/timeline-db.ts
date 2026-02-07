import pg from 'pg';

const { Pool } = pg;

export interface Thread {
  id: number;
  name: string;
  description: string | null;
  parent_thought_id: number | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface Thought {
  id: number;
  thread_id: number;
  parent_thought_id: number | null;
  content: string;
  thought_type: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ThreadPosition {
  thread_id: number;
  current_thought_id: number;
  updated_at: Date;
}

export interface ThreadWithPosition extends Thread {
  current_thought_id: number | null;
  current_thought_content: string | null;
  thought_count: number;
  tangent_count: number;
}

export interface ThreadDetail extends Thread {
  thoughts: Thought[];
  tangent_threads: Thread[];
  current_thought_id: number | null;
}

export class TimelineDB {
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

  // --- Threads ---

  async createThread(name: string, description?: string, parentThoughtId?: number): Promise<Thread> {
    const result = await this.pool.query<Thread>(
      `INSERT INTO timeline.threads (name, description, parent_thought_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, description ?? null, parentThoughtId ?? null]
    );
    return result.rows[0];
  }

  async listThreads(status?: string): Promise<ThreadWithPosition[]> {
    let query = `
      SELECT t.*,
        tp.current_thought_id,
        ct.content AS current_thought_content,
        (SELECT COUNT(*) FROM timeline.thoughts th WHERE th.thread_id = t.id)::int AS thought_count,
        (SELECT COUNT(*) FROM timeline.threads child WHERE child.parent_thought_id IN
          (SELECT id FROM timeline.thoughts WHERE thread_id = t.id))::int AS tangent_count
      FROM timeline.threads t
      LEFT JOIN timeline.thread_position tp ON tp.thread_id = t.id
      LEFT JOIN timeline.thoughts ct ON ct.id = tp.current_thought_id
    `;
    const params: unknown[] = [];

    if (status) {
      query += ' WHERE t.status = $1';
      params.push(status);
    }

    query += ' ORDER BY t.updated_at DESC';

    const result = await this.pool.query<ThreadWithPosition>(query, params);
    return result.rows;
  }

  async getThread(threadId: number): Promise<ThreadDetail | null> {
    const threadResult = await this.pool.query<Thread>(
      'SELECT * FROM timeline.threads WHERE id = $1',
      [threadId]
    );

    if (threadResult.rows.length === 0) return null;

    const thread = threadResult.rows[0];

    // Get ordered thoughts (follow parent chain)
    const thoughtsResult = await this.pool.query<Thought>(
      `WITH RECURSIVE thought_chain AS (
        SELECT * FROM timeline.thoughts
        WHERE thread_id = $1 AND parent_thought_id IS NULL
        UNION ALL
        SELECT t.* FROM timeline.thoughts t
        JOIN thought_chain tc ON t.parent_thought_id = tc.id
        WHERE t.thread_id = $1
      )
      SELECT * FROM thought_chain ORDER BY created_at ASC`,
      [threadId]
    );

    // Get tangent threads (children spawned from thoughts in this thread)
    const tangentsResult = await this.pool.query<Thread>(
      `SELECT t.* FROM timeline.threads t
       WHERE t.parent_thought_id IN (SELECT id FROM timeline.thoughts WHERE thread_id = $1)
       ORDER BY t.created_at ASC`,
      [threadId]
    );

    // Get current position
    const posResult = await this.pool.query<ThreadPosition>(
      'SELECT * FROM timeline.thread_position WHERE thread_id = $1',
      [threadId]
    );

    return {
      ...thread,
      thoughts: thoughtsResult.rows,
      tangent_threads: tangentsResult.rows,
      current_thought_id: posResult.rows[0]?.current_thought_id ?? null,
    };
  }

  async updateThreadStatus(threadId: number, status: string): Promise<Thread | null> {
    const result = await this.pool.query<Thread>(
      `UPDATE timeline.threads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [threadId, status]
    );
    return result.rows[0] ?? null;
  }

  // --- Thoughts ---

  async addThought(
    threadId: number,
    content: string,
    thoughtType: string = 'progress',
    metadata?: Record<string, unknown>
  ): Promise<Thought> {
    // Get the latest thought in the thread to set as parent
    const latestResult = await this.pool.query<{ id: number }>(
      `SELECT tp.current_thought_id AS id FROM timeline.thread_position tp
       WHERE tp.thread_id = $1
       UNION ALL
       SELECT t.id FROM timeline.thoughts t
       WHERE t.thread_id = $1 ORDER BY t.created_at DESC LIMIT 1`,
      [threadId]
    );

    const parentId = latestResult.rows[0]?.id ?? null;

    const result = await this.pool.query<Thought>(
      `INSERT INTO timeline.thoughts (thread_id, parent_thought_id, content, thought_type, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [threadId, parentId, content, thoughtType, JSON.stringify(metadata ?? {})]
    );

    const thought = result.rows[0];

    // Update thread position
    await this.pool.query(
      `INSERT INTO timeline.thread_position (thread_id, current_thought_id)
       VALUES ($1, $2)
       ON CONFLICT (thread_id) DO UPDATE SET current_thought_id = $2, updated_at = now()`,
      [threadId, thought.id]
    );

    // Update thread updated_at
    await this.pool.query(
      'UPDATE timeline.threads SET updated_at = now() WHERE id = $1',
      [threadId]
    );

    return thought;
  }

  async updateThought(thoughtId: number, updates: { content?: string; status?: string; metadata?: Record<string, unknown> }): Promise<Thought | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (updates.content !== undefined) {
      setClauses.push(`content = $${paramIdx++}`);
      params.push(updates.content);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIdx++}`);
      params.push(updates.status);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIdx++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length === 0) return null;

    params.push(thoughtId);
    const result = await this.pool.query<Thought>(
      `UPDATE timeline.thoughts SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );
    return result.rows[0] ?? null;
  }

  // --- Navigation ---

  async whereAmI(): Promise<{ active_threads: ThreadWithPosition[] }> {
    const threads = await this.listThreads('active');
    return { active_threads: threads };
  }

  async goTangent(
    currentThreadId: number,
    tangentName: string,
    tangentDescription?: string,
    reason?: string
  ): Promise<{ tangent_start_thought: Thought; tangent_thread: Thread }> {
    // Add a tangent_start thought to the current thread
    const tangentStartThought = await this.addThought(
      currentThreadId,
      reason ?? `Going on tangent: ${tangentName}`,
      'tangent_start',
      { tangent_name: tangentName }
    );

    // Create the tangent thread
    const tangentThread = await this.createThread(
      tangentName,
      tangentDescription,
      tangentStartThought.id
    );

    return { tangent_start_thought: tangentStartThought, tangent_thread: tangentThread };
  }

  async returnFromTangent(
    tangentThreadId: number,
    summary?: string,
    markAs: string = 'completed'
  ): Promise<{ tangent_thread: Thread; parent_thread: Thread | null; parent_thought: Thought | null }> {
    // Get the tangent thread
    const threadResult = await this.pool.query<Thread>(
      'SELECT * FROM timeline.threads WHERE id = $1',
      [tangentThreadId]
    );

    if (threadResult.rows.length === 0) {
      throw new Error(`Thread ${tangentThreadId} not found`);
    }

    const tangentThread = threadResult.rows[0];

    if (!tangentThread.parent_thought_id) {
      throw new Error(`Thread ${tangentThreadId} is not a tangent (no parent_thought_id)`);
    }

    // Add a summary thought before closing if provided
    if (summary) {
      await this.addThought(tangentThreadId, summary, 'progress', { type: 'tangent_summary' });
    }

    // Mark tangent thread
    await this.updateThreadStatus(tangentThreadId, markAs);

    // Find the parent thread via parent_thought_id
    const parentThoughtResult = await this.pool.query<Thought>(
      'SELECT * FROM timeline.thoughts WHERE id = $1',
      [tangentThread.parent_thought_id]
    );

    const parentThought = parentThoughtResult.rows[0] ?? null;

    let parentThread: Thread | null = null;
    if (parentThought) {
      const parentThreadResult = await this.pool.query<Thread>(
        'SELECT * FROM timeline.threads WHERE id = $1',
        [parentThought.thread_id]
      );
      parentThread = parentThreadResult.rows[0] ?? null;
    }

    return {
      tangent_thread: { ...tangentThread, status: markAs },
      parent_thread: parentThread,
      parent_thought: parentThought,
    };
  }
}
