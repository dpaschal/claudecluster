import { Logger } from 'winston';
import { TimelineDB } from './timeline-db.js';
import { ToolHandler } from './tools.js';

export interface TimelineToolsConfig {
  logger: Logger;
  connectionString?: string;
}

export function createTimelineTools(config: TimelineToolsConfig): { tools: Map<string, ToolHandler>; db: TimelineDB } {
  const db = new TimelineDB(config.connectionString);
  const tools = new Map<string, ToolHandler>();

  // timeline_create_thread
  tools.set('timeline_create_thread', {
    description: 'Create a new timeline thread (a named journey from A to B). Use parent_thought_id to create a tangent from an existing thought.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Thread name, e.g., "claudecluster v0.2" or "fix gRPC field names"',
        },
        description: {
          type: 'string',
          description: 'What this thread is about / the goal',
        },
        parent_thought_id: {
          type: 'number',
          description: 'If this is a tangent, the thought ID it branches from',
        },
      },
      required: ['name'],
    },
    handler: async (args) => {
      const thread = await db.createThread(
        args.name as string,
        args.description as string | undefined,
        args.parent_thought_id as number | undefined
      );
      config.logger.info('Timeline thread created', { threadId: thread.id, name: thread.name });
      return thread;
    },
  });

  // timeline_list_threads
  tools.set('timeline_list_threads', {
    description: 'List all timeline threads with their current position, thought count, and tangent count.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status',
          enum: ['active', 'completed', 'paused', 'abandoned'],
        },
      },
    },
    handler: async (args) => {
      const threads = await db.listThreads(args.status as string | undefined);
      return threads;
    },
  });

  // timeline_get_thread
  tools.set('timeline_get_thread', {
    description: 'Get a thread with all its thoughts in order and any tangent threads that branch from it.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'number',
          description: 'Thread ID to retrieve',
        },
      },
      required: ['thread_id'],
    },
    handler: async (args) => {
      const thread = await db.getThread(args.thread_id as number);
      if (!thread) {
        throw new Error(`Thread ${args.thread_id} not found`);
      }
      return thread;
    },
  });

  // timeline_add_thought
  tools.set('timeline_add_thought', {
    description: 'Add a thought (waypoint) to a thread. Automatically chains to the latest thought in the thread.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: {
          type: 'number',
          description: 'Thread to add the thought to',
        },
        content: {
          type: 'string',
          description: 'The thought content (freeform text)',
        },
        thought_type: {
          type: 'string',
          description: 'Type of thought',
          enum: ['idea', 'decision', 'discovery', 'blocker', 'progress', 'tangent_start'],
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata (links to files, commits, runbooks, session IDs)',
        },
      },
      required: ['thread_id', 'content'],
    },
    handler: async (args) => {
      const thought = await db.addThought(
        args.thread_id as number,
        args.content as string,
        args.thought_type as string | undefined,
        args.metadata as Record<string, unknown> | undefined
      );
      config.logger.info('Timeline thought added', { thoughtId: thought.id, threadId: thought.thread_id, type: thought.thought_type });
      return thought;
    },
  });

  // timeline_update_thought
  tools.set('timeline_update_thought', {
    description: 'Update a thought — change its status, content, or metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        thought_id: {
          type: 'number',
          description: 'Thought ID to update',
        },
        content: {
          type: 'string',
          description: 'New content (replaces existing)',
        },
        status: {
          type: 'string',
          description: 'New status',
          enum: ['active', 'resolved', 'abandoned'],
        },
        metadata: {
          type: 'object',
          description: 'New metadata (replaces existing)',
        },
      },
      required: ['thought_id'],
    },
    handler: async (args) => {
      const thought = await db.updateThought(args.thought_id as number, {
        content: args.content as string | undefined,
        status: args.status as string | undefined,
        metadata: args.metadata as Record<string, unknown> | undefined,
      });
      if (!thought) {
        throw new Error(`Thought ${args.thought_id} not found or no updates provided`);
      }
      return thought;
    },
  });

  // timeline_where_am_i
  tools.set('timeline_where_am_i', {
    description: 'Show current position across all active threads. Use this at the start of a session to understand where you left off. Returns all active threads with their latest thought and tangent count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const result = await db.whereAmI();
      return result;
    },
  });

  // timeline_go_tangent
  tools.set('timeline_go_tangent', {
    description: 'Go on a tangent: creates a tangent_start marker on the current thread and spawns a new child thread. Use this when you\'re about to explore a side-topic.',
    inputSchema: {
      type: 'object',
      properties: {
        current_thread_id: {
          type: 'number',
          description: 'The thread you\'re currently on',
        },
        tangent_name: {
          type: 'string',
          description: 'Name for the tangent thread',
        },
        tangent_description: {
          type: 'string',
          description: 'What this tangent is about',
        },
        reason: {
          type: 'string',
          description: 'Why you\'re going on this tangent (logged as the tangent_start thought)',
        },
      },
      required: ['current_thread_id', 'tangent_name'],
    },
    handler: async (args) => {
      const result = await db.goTangent(
        args.current_thread_id as number,
        args.tangent_name as string,
        args.tangent_description as string | undefined,
        args.reason as string | undefined
      );
      config.logger.info('Timeline tangent started', {
        parentThreadId: args.current_thread_id,
        tangentThreadId: result.tangent_thread.id,
        tangentName: args.tangent_name,
      });
      return result;
    },
  });

  // timeline_return
  tools.set('timeline_return', {
    description: 'Return from a tangent: marks the tangent thread as completed/paused and shows you the parent thread to resume. Use this when you\'re done with a side-topic.',
    inputSchema: {
      type: 'object',
      properties: {
        tangent_thread_id: {
          type: 'number',
          description: 'The tangent thread ID to return from',
        },
        summary: {
          type: 'string',
          description: 'Summary of what was accomplished on this tangent (added as final thought)',
        },
        mark_as: {
          type: 'string',
          description: 'How to mark the tangent thread',
          enum: ['completed', 'paused', 'abandoned'],
        },
      },
      required: ['tangent_thread_id'],
    },
    handler: async (args) => {
      const result = await db.returnFromTangent(
        args.tangent_thread_id as number,
        args.summary as string | undefined,
        args.mark_as as string | undefined
      );
      config.logger.info('Timeline returned from tangent', {
        tangentThreadId: args.tangent_thread_id,
        parentThreadId: result.parent_thread?.id,
      });
      return result;
    },
  });

  return { tools, db };
}
