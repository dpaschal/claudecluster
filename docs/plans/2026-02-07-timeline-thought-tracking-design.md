# Timeline: Thought Tracking System

## Problem

When working on projects, tangents are inevitable and valuable — but context is lost when Claude sessions crash, conversations compress, or days pass. There's no persistent way to track "where was I?" across the branching paths of thought.

## Solution

A `timeline` schema in the `cerebrus` PostgreSQL database on anvil (192.168.1.138), exposed as MCP tools in claudecluster. Every Claude session on the mesh can read/write thoughts, navigate threads, and pick up where any previous session left off.

## Schema: `timeline` (in cerebrus database)

### `timeline.threads`

Named journeys from A→B.

| Column | Type | Description |
|--------|------|-------------|
| id | serial PK | |
| name | text NOT NULL | e.g., "claudecluster v0.2" |
| description | text | What the goal is |
| parent_thought_id | int → thoughts.id | NULL for root threads, set for tangents |
| status | text | `active`, `completed`, `paused`, `abandoned` |
| created_at | timestamptz | DEFAULT now() |
| updated_at | timestamptz | DEFAULT now() |

### `timeline.thoughts`

Waypoints along a thread.

| Column | Type | Description |
|--------|------|-------------|
| id | serial PK | |
| thread_id | int → threads.id | Which thread this belongs to |
| parent_thought_id | int → self | Previous thought in sequence (NULL for first) |
| content | text NOT NULL | Freeform note |
| thought_type | text | `idea`, `decision`, `discovery`, `blocker`, `progress`, `tangent_start` |
| status | text | `active`, `resolved`, `abandoned` |
| metadata | jsonb | Links to files, commits, runbooks, session IDs |
| created_at | timestamptz | DEFAULT now() |

### `timeline.thread_position`

"You are here" markers.

| Column | Type | Description |
|--------|------|-------------|
| thread_id | int → threads.id | UNIQUE |
| current_thought_id | int → thoughts.id | |
| updated_at | timestamptz | DEFAULT now() |

### Key Relationships

- A **root thread** has `parent_thought_id = NULL`
- A **tangent thread** has `parent_thought_id` pointing to a thought in a parent thread
- A `tangent_start` thought marks "I went down a rabbit hole here"
- Navigation back: follow `parent_thought_id` from tangent thread → parent thought → parent thread

## MCP Tools

Added to `src/mcp/timeline-tools.ts`, registered in the existing MCP server.

### Thread Management

- **`timeline_create_thread`** — `name`, `description`, optional `parent_thought_id`
- **`timeline_list_threads`** — All threads with status and current position, optional `status` filter
- **`timeline_get_thread`** — Full thread with ordered thoughts and child tangent threads

### Thought Tracking

- **`timeline_add_thought`** — `thread_id`, `content`, `thought_type`, optional `metadata`
- **`timeline_update_thought`** — Change status, update content by `thought_id`
- **`timeline_where_am_i`** — Show current position across all active threads (the "breadcrumb back" tool)

### Navigation

- **`timeline_go_tangent`** — Creates `tangent_start` thought on current thread, spawns child thread, updates position
- **`timeline_return`** — Marks tangent as completed/paused, restores parent thread position

## Implementation Steps

1. Create `timeline` schema and tables on anvil via SQL over SSH
2. Add `pg` dependency to claudecluster
3. Create `src/mcp/timeline-db.ts` — PostgreSQL connection pool and query helpers
4. Create `src/mcp/timeline-tools.ts` — MCP tool definitions and handlers
5. Register timeline tools in `src/mcp/server.ts`
6. Test with a real Claude session

## Connection

PostgreSQL via `pg` module over Tailscale:
- Host: `100.69.42.106`
- Database: `cerebrus`
- User: `cerebrus`
- Schema: `timeline`
