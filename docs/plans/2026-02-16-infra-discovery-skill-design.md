# Infrastructure Discovery Skill — Design

**Date:** 2026-02-16
**Status:** Approved
**Form:** Claude Code personal skill (`~/.claude/skills/infra-discovery/SKILL.md`)

## Purpose

A Claude Code skill that discovers and inventories infrastructure across all SSH-able hosts, diffs findings against cerebrus context entries, and keeps the database current. Prevents the "Claude doesn't know about critical infrastructure" problem.

## Two Modes

### Quick Health Check (bootstrap)

Runs at every session start as part of the standard bootstrap flow. Target: ~15 seconds.

**Checks:**
- Disk usage on forge, anvil, terminus (flag >85%)
- Critical service status: K3s, cloudflared, sentinel, claudecluster, postgresql
- K3s pod health: count Running vs not-Running pods
- Existing `alert:*` cerebrus entries — check if resolved

**Output:** 3-5 line health summary printed to user. Only writes to cerebrus if state changed (new alert or resolved alert).

**Integration:** Add to CLAUDE.md bootstrap section, after the existing timeline/context queries.

### Full Audit (on demand)

Triggered by user request ("audit infrastructure", "discover services", "update infra"). Deep crawl of all managed hosts.

**Per-Host Checks:**

| Host | IP | Checks |
|------|----|--------|
| forge | 192.168.1.200 / 10.0.10.11 | systemd services, K3s (deployments, pods, ingress, certs, namespaces), ZFS pool, disk, /work/ai/ projects, PXE/dnsmasq, cloudflared, networking |
| anvil | 192.168.1.138 | systemd services, PostgreSQL (databases, schemas, tables), Borg backups, Syncthing, disk |
| terminus | 100.120.202.76 | systemd services, OpenClaw, running dev services, claudecluster, disk |
| htnas02 | 10.0.10.10 | ZFS pools, SMB/NFS shares, Plex, Docker containers, disk |

**Execution:** Dispatch parallel subagents (one per host) using `superpowers:dispatching-parallel-agents`. Each subagent SSHs in, gathers data, returns structured JSON.

**Post-Crawl:**
1. Fetch existing `infra:*` and `alert:*` context entries from cerebrus
2. Diff findings against existing entries
3. Generate SQL for INSERTs (new infrastructure) and UPDATEs (changed state)
4. Execute against cerebrus via SSH+psql
5. Report summary of changes to user

## Conventions

### SSH
```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@<host>
```

### Context Entry Keys
- `infra:<topic>` — infrastructure facts (category: `fact` or `machine`)
- `alert:<topic>` — active alerts requiring attention (category: `reminder`)
- Machine entries use category `machine`, everything else uses `fact`

### JSONB Value Structure
Structured data, not prose. Example:
```json
{
  "os": "Fedora 42",
  "services": ["k3s", "postgresql", "cloudflared"],
  "disk_usage": {"root": "95%", "zfs": "0.1%"},
  "critical_issue": "Root disk 100% full"
}
```

### Categories
Valid: `project`, `pr`, `machine`, `waiting`, `fact`, `reminder`

## Skill Structure

```
~/.claude/skills/infra-discovery/
  SKILL.md              # Main skill — overview, health check commands, trigger conditions
  full-audit-hosts.md   # Per-host command reference for full audits
```

## CLAUDE.md Integration

Add to the "Session Bootstrap" section:
```
5. Quick infrastructure health check (infra-discovery skill):
   - SSH to forge/anvil/terminus, check disk + critical services
   - Compare against cerebrus alerts, flag changes
```

## Skill Description (CSO-Optimized)

```yaml
name: infra-discovery
description: Use when starting a session (bootstrap health check), when infrastructure state is unknown, when the user asks to audit/discover/inventory services, or when cerebrus infra context is stale
```

## Non-Goals

- Real-time monitoring (Sentinel handles this)
- Automated remediation (reports only, human decides)
- Non-SSH hosts (IoT, phones, etc.)
- Network scanning (Sentinel handles this)
