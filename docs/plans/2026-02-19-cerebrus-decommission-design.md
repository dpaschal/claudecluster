# Cerebrus Decommission & Dual-Path Bootstrap Design

## Goal

Remove all cerebrus PostgreSQL dependencies from the Claude session bootstrap. Replace with two paths: cortex MCP (primary) and a static `~/.cortex/whereami.md` snapshot (fallback).

## Architecture

Two-path bootstrap, no more cerebrus:

1. **Path 1 — Cortex MCP** (primary): `memory_whereami` returns live data from local SQLite. Used when cortex service is running and MCP is configured.

2. **Path 2 — Static snapshot** (fallback): Read `~/.cortex/whereami.md`, a markdown file that SharedMemoryDB regenerates on every write to timeline/context tables. Always present on disk, always fresh.

Cerebrus PostgreSQL becomes a read-only archive. All SSH+psql references removed from CLAUDE.md. KeePass and infra health checks remain unchanged (SSH-based, unrelated to cerebrus).

## Snapshot Generation

`SharedMemoryDB.run()` gets a post-write hook. After any successful write, it checks if the affected SQL touches a timeline or context table (string match on `timeline_` or `_context`). If so, it calls `generateWhereami()` which:

1. Queries active threads + current positions + latest thought per thread
2. Queries pinned context entries
3. Queries recent thoughts (last 5 across all threads)
4. Writes `~/.cortex/whereami.md` with structured markdown

### Snapshot format

```markdown
# Cortex State — <ISO timestamp>

## Active Threads
- **#<id> <name>** (project: <project>) — <N> thoughts
  Position: thought #<id> — "<truncated content>..."

## Pinned Context
- `<key>`: <value>

## Recent Thoughts
1. #<id> (<type>, thread #<tid>): <truncated content>...
```

Generation is lightweight: 3-4 SQLite queries on local DB, write ~5KB file. Synchronous after DB write since it's all local I/O.

## CLAUDE.md Changes

- **Remove**: "Fallback: SSH+psql" section
- **Remove**: "Cerebrus Database (LEGACY)" section
- **Update**: Bootstrap to try `memory_whereami` first, read `~/.cortex/whereami.md` if MCP unavailable
- **Keep**: KeePass vault section (SSH to anvil, credentials — NOT DELETED)
- **Keep**: Infra health check section (SSH-based service checks)
- **Keep**: Anvil server section (remove PostgreSQL credential line only)

### New bootstrap flow

```
1. memory_whereami (MCP) — if available, use this
2. Read ~/.cortex/whereami.md — if MCP unavailable, read the snapshot
3. KeePass vault — credentials (unchanged)
4. Infra health check — SSH to forge/anvil/terminus (unchanged)
```

## What Stays

- `cerebrus` PostgreSQL on anvil — keeps running as read-only archive
- Migration script (`scripts/migrate-to-shared-memory.ts`) — recovery tool
- KeePass on anvil — credential source of truth
- Infra health checks via SSH

## What Goes

- All `psql` commands from CLAUDE.md
- "Cerebrus Database (LEGACY)" section from CLAUDE.md
- Dual-writing pattern (no more writing to both cerebrus AND shared-memory)

## What's New

- `generateWhereami()` method in SharedMemoryDB
- `~/.cortex/whereami.md` auto-generated on every timeline/context write
- Updated CLAUDE.md with two-path bootstrap
