# Infrastructure Discovery Skill — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a personal Claude Code skill that performs quick infrastructure health checks at session bootstrap and full audits on demand, keeping cerebrus context entries current.

**Architecture:** Two-file skill at `~/.claude/skills/infra-discovery/`. SKILL.md contains the overview, health check commands, and trigger logic. `full-audit-hosts.md` contains per-host deep audit command reference. CLAUDE.md gets a new bootstrap step.

**Tech Stack:** Markdown (SKILL.md), SSH, psql, kubectl, systemctl, df, zpool

---

### Task 1: Create Skill Directory

**Files:**
- Create: `~/.claude/skills/infra-discovery/` (directory)

**Step 1: Create the directory**

```bash
mkdir -p ~/.claude/skills/infra-discovery
```

**Step 2: Verify**

```bash
ls -la ~/.claude/skills/infra-discovery/
```
Expected: empty directory exists

---

### Task 2: Write SKILL.md — Main Skill File

**Files:**
- Create: `~/.claude/skills/infra-discovery/SKILL.md`

**Step 1: Write the skill file**

Write `~/.claude/skills/infra-discovery/SKILL.md` with this content:

````markdown
---
name: infra-discovery
description: Use when starting a session (bootstrap health check), when infrastructure state is unknown, when the user asks to audit/discover/inventory services, or when cerebrus infra context is stale
---

# Infrastructure Discovery

## Overview

Discover and inventory infrastructure across SSH-able hosts, diff against cerebrus context, and keep the database current. Two modes: quick health check (bootstrap) and full audit (on demand).

## When to Use

- **Session bootstrap** — run the Quick Health Check after timeline/context queries
- **User asks** to audit, discover, or inventory infrastructure
- **Infrastructure state unknown** — you don't know what services run where
- **Cerebrus infra context stale** — `infra:*` entries older than 7 days
- **After infrastructure changes** — new services deployed, hosts added/removed

## Quick Health Check (Bootstrap Mode)

Run these 3 commands in parallel after the standard bootstrap queries. Target: ~15 seconds total.

**1. Disk + services on forge:**
```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.200 "df -h / /work 2>/dev/null; echo '---'; systemctl is-active k3s cloudflared sentinel claudecluster postgresql 2>/dev/null; echo '---'; kubectl get pods -A --no-headers 2>/dev/null | awk '{print \$4}' | sort | uniq -c"
```

**2. Disk + services on anvil:**
```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.138 "df -h /; echo '---'; systemctl is-active postgresql syncthing sshd 2>/dev/null"
```

**3. Disk on terminus (Tailscale):**
```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@100.120.202.76 "df -h /; echo '---'; systemctl --user is-active openclaw-gateway 2>/dev/null; systemctl is-active claudecluster 2>/dev/null" 2>/dev/null || echo "terminus: unreachable"
```

### Interpreting Results

- **Disk >85%**: Flag as warning. >95%: Flag as CRITICAL alert.
- **Service inactive/failed**: Flag as alert.
- **K3s pods not Running**: Count and flag if >3 non-Running pods.
- **Host unreachable**: Note but don't alert (may be offline).

### Writing Alerts to Cerebrus

Only write if state CHANGED (new alert or existing alert resolved):

**New alert:**
```sql
INSERT INTO timeline.context (key, category, label, value)
VALUES ('alert:<topic>', 'reminder', '<short label>', '<JSONB>')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
```

**Resolve alert (delete when fixed):**
```sql
DELETE FROM timeline.context WHERE key = 'alert:<topic>';
```

### Output Format

Print a concise health summary:
```
Infrastructure: forge OK (disk 45%) | anvil OK (disk 62%) | terminus unreachable
K3s: 18/21 pods running, 3 down (disk pressure)
Alerts: 1 active (forge root disk CRITICAL)
```

## Full Audit (On-Demand Mode)

Triggered by: "audit infrastructure", "discover services", "update infra", "crawl environment"

**REQUIRED:** Use `superpowers:dispatching-parallel-agents` to run one subagent per host.

Each subagent should:
1. SSH into the host
2. Run the commands from `full-audit-hosts.md`
3. Return structured findings as JSON

After all subagents complete:
1. Fetch existing context: `SELECT key, value FROM timeline.context WHERE key LIKE 'infra:%' OR key LIKE 'alert:%';`
2. Diff each finding against existing entries
3. Generate and execute INSERT/UPDATE SQL for changes
4. Report summary: N new entries, M updated, K unchanged

### Context Entry Conventions

| Key Pattern | Category | Use For |
|-------------|----------|---------|
| `infra:<hostname>` | `machine` | Per-host overview (OS, CPU, RAM, IPs, services) |
| `infra:<topic>` | `fact` | Cross-host infrastructure (network, DNS, K3s, backups) |
| `alert:<topic>` | `reminder` | Active issues needing attention |

### JSONB Value Structure

Use structured data, not prose:
```json
{
  "os": "Fedora 42",
  "services": ["k3s", "postgresql"],
  "disk": {"root": "45%", "zfs_used": "88.5 GiB / 69.9 TiB"},
  "critical_issue": null
}
```

## Managed Hosts

| Host | IP | SSH User | Role |
|------|-----|----------|------|
| forge | 192.168.1.200 | paschal | K3s cluster, 10GbE infra, ZFS storage |
| anvil | 192.168.1.138 | paschal | Cerebrus DB, backups, KeePass |
| terminus | 100.120.202.76 | paschal | Workstation, OpenClaw, dev |
| htnas02 | 10.0.10.10 | paschal | NAS, ZFS, Plex, Docker |

## Common Mistakes

- **Using wrong IP for forge**: Use 192.168.1.200 (LAN), not 10.0.10.11 (10GbE VLAN)
- **Forgetting ConnectTimeout**: Always use `-o ConnectTimeout=5` to avoid hanging on unreachable hosts
- **Writing prose to cerebrus**: Use structured JSONB, not paragraphs
- **Invalid category**: Only `project`, `pr`, `machine`, `waiting`, `fact`, `reminder` are valid
- **Not diffing first**: Always fetch existing entries before writing — avoid clobbering recent manual updates
````

**Step 2: Verify word count**

```bash
wc -w ~/.claude/skills/infra-discovery/SKILL.md
```
Expected: under 500 words (target for non-frequently-loaded skills)

---

### Task 3: Write full-audit-hosts.md — Per-Host Command Reference

**Files:**
- Create: `~/.claude/skills/infra-discovery/full-audit-hosts.md`

**Step 1: Write the reference file**

Write `~/.claude/skills/infra-discovery/full-audit-hosts.md` with this content:

````markdown
# Full Audit — Per-Host Commands

Commands for deep infrastructure audit. Run via SSH. Each host section is independent — dispatch as parallel subagents.

## forge (192.168.1.200)

```bash
SSH="ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.200"

# OS + hardware
$SSH "hostnamectl; uname -r; nproc; free -h | head -2"

# Disk
$SSH "df -h / /work; lsblk -o NAME,SIZE,TYPE,MOUNTPOINT"

# ZFS
$SSH "zpool status -x; zpool list; zfs list -o name,used,avail,mountpoint"

# systemd services (enabled, non-default)
$SSH "systemctl list-unit-files --state=enabled --type=service --no-pager | grep -v '@\|dbus\|getty\|ssh\|systemd\|user@\|NetworkManager\|firewalld\|chronyd\|crond\|auditd'"

# K3s cluster
$SSH "kubectl get nodes -o wide; kubectl get pods -A -o wide; kubectl get deployments -A; kubectl get svc -A; kubectl get ingress -A 2>/dev/null; kubectl get ingressroute -A 2>/dev/null"

# K3s certificates
$SSH "kubectl get certificates -A 2>/dev/null; kubectl get clusterissuers 2>/dev/null"

# Cloudflare tunnel
$SSH "systemctl is-active cloudflared; cloudflared tunnel list 2>/dev/null"

# Network
$SSH "ip -4 addr show | grep 'inet '; ip route show default"

# Projects in /work/ai/
$SSH "ls -1 /work/ai/ 2>/dev/null"

# PXE/dnsmasq
$SSH "systemctl is-active dnsmasq; cat /etc/dnsmasq.d/pxe.conf 2>/dev/null | head -20"

# PostgreSQL
$SSH "sudo -u postgres psql -c '\\l' 2>/dev/null || psql -U cerebrus -d cerebrus -c '\\dt' 2>/dev/null"
```

## anvil (192.168.1.138)

```bash
SSH="ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.138"

# OS + hardware
$SSH "hostnamectl; uname -r; nproc; free -h | head -2"

# Disk
$SSH "df -h /"

# systemd services
$SSH "systemctl list-unit-files --state=enabled --type=service --no-pager | grep -v '@\|dbus\|getty\|ssh\|systemd\|user@\|NetworkManager'"

# PostgreSQL databases + schemas
$SSH "psql -U cerebrus -d cerebrus -c '\\l'"
$SSH "psql -U cerebrus -d cerebrus -c \"SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast');\""
$SSH "psql -U cerebrus -d cerebrus -c \"SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename;\""

# Borg backups
$SSH "ls -la /var/lib/borg/ 2>/dev/null; borg list /var/lib/borg/anvil 2>/dev/null | tail -5"

# Syncthing
$SSH "systemctl is-active syncthing@paschal; ls ~/Sync/ 2>/dev/null"

# Network
$SSH "ip -4 addr show | grep 'inet '; ip route show default"
```

## terminus (100.120.202.76)

```bash
SSH="ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@100.120.202.76"

# OS + hardware
$SSH "hostnamectl; uname -r; nproc; free -h | head -2"

# Disk
$SSH "df -h /"

# systemd services (system + user)
$SSH "systemctl list-unit-files --state=enabled --type=service --no-pager | grep -v '@\|dbus\|getty\|ssh\|systemd\|user@'"
$SSH "systemctl --user list-unit-files --state=enabled --type=service --no-pager 2>/dev/null"

# OpenClaw
$SSH "systemctl --user is-active openclaw-gateway; ls ~/.openclaw/openclaw.json 2>/dev/null && echo 'config exists'"

# Network
$SSH "ip -4 addr show | grep 'inet '; ip route show default"
```

## htnas02 (10.0.10.10)

```bash
SSH="ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@10.0.10.10"

# OS + hardware
$SSH "hostnamectl; uname -r; nproc; free -h | head -2"

# Disk
$SSH "df -h / /mnt/tank 2>/dev/null"

# ZFS
$SSH "zpool status -x; zpool list; zfs list -o name,used,avail,mountpoint -d 1 2>/dev/null"

# Docker containers
$SSH "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null"

# SMB shares
$SSH "cat /etc/samba/smb.conf 2>/dev/null | grep '^\[' | grep -v global"

# NFS exports
$SSH "cat /etc/exports 2>/dev/null; showmount -e localhost 2>/dev/null"

# Plex
$SSH "docker ps --filter name=plex --format '{{.Status}}' 2>/dev/null || systemctl is-active plexmediaserver 2>/dev/null"

# Network
$SSH "ip -4 addr show | grep 'inet '; ip route show default"
```
````

---

### Task 4: Update CLAUDE.md — Add Bootstrap Health Check Step

**Files:**
- Modify: `~/.claude/CLAUDE.md` (add step 5 to Session Bootstrap section)

**Step 1: Add the health check step**

After the existing step 4 (KeePass credential retrieval), add:

```markdown
5. Quick infrastructure health check (run these 3 in parallel):
```
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.200 "df -h / /work 2>/dev/null | tail -2; echo '---'; systemctl is-active k3s cloudflared sentinel claudecluster postgresql 2>/dev/null; echo '---'; kubectl get pods -A --no-headers 2>/dev/null | awk '{print \$4}' | sort | uniq -c"
```
```
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.138 "df -h / | tail -1; echo '---'; systemctl is-active postgresql syncthing sshd 2>/dev/null"
```
```
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@100.120.202.76 "df -h / | tail -1; echo '---'; systemctl --user is-active openclaw-gateway 2>/dev/null; systemctl is-active claudecluster 2>/dev/null" 2>/dev/null || echo "terminus: unreachable"
```
Flag disk >85% as warning, >95% as CRITICAL. Flag inactive/failed services. Report K3s pod count. If state changed, update cerebrus alerts (see infra-discovery skill).
```

**Step 2: Verify the edit**

Read `~/.claude/CLAUDE.md` and confirm step 5 appears after step 4.

---

### Task 5: Test the Skill — Verify Health Check Commands Work

**Step 1: Run the forge health check command**

```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.200 "df -h / /work 2>/dev/null | tail -2; echo '---'; systemctl is-active k3s cloudflared sentinel claudecluster postgresql 2>/dev/null; echo '---'; kubectl get pods -A --no-headers 2>/dev/null | awk '{print \$4}' | sort | uniq -c"
```

Expected: disk usage lines, service statuses (active/inactive), pod state counts.

**Step 2: Run the anvil health check command**

```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@192.168.1.138 "df -h / | tail -1; echo '---'; systemctl is-active postgresql syncthing sshd 2>/dev/null"
```

Expected: disk usage line, 3 service statuses.

**Step 3: Run the terminus health check command**

```bash
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no paschal@100.120.202.76 "df -h / | tail -1; echo '---'; systemctl --user is-active openclaw-gateway 2>/dev/null; systemctl is-active claudecluster 2>/dev/null" 2>/dev/null || echo "terminus: unreachable"
```

Expected: disk usage + service status, or "unreachable" if offline.

**Step 4: Verify output is interpretable**

Confirm you can produce a health summary like:
```
Infrastructure: forge CRITICAL (root 100%) | anvil OK (62%) | terminus OK (45%)
K3s: 6/21 pods running, 15 down (DiskPressure)
Alerts: 1 active (alert:forge-disk)
```

---

### Task 6: Commit

**Step 1: Stage and commit skill files**

```bash
git add ~/.claude/skills/infra-discovery/SKILL.md ~/.claude/skills/infra-discovery/full-audit-hosts.md
```

Note: `~/.claude/skills/` is outside the repo. These files won't be tracked by the claudecluster repo. Only the design doc and plan are committed:

```bash
cd ~/claudecluster
git add docs/plans/2026-02-16-infra-discovery-skill-design.md docs/plans/2026-02-16-infra-discovery-implementation-plan.md
git commit -m "feat: add infrastructure discovery skill design and plan

Personal skill at ~/.claude/skills/infra-discovery/ with two modes:
- Quick health check at session bootstrap (~15s)
- Full audit on demand with parallel subagents per host

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Log to Timeline

**Step 1: Log a progress thought**

```sql
INSERT INTO timeline.thoughts (thread_id, content, thought_type)
VALUES (7, 'Infrastructure discovery skill created at ~/.claude/skills/infra-discovery/. Two modes: quick health check (bootstrap, ~15s) and full audit (on demand, parallel subagents). CLAUDE.md updated with step 5 for bootstrap health checks. Design doc at docs/plans/2026-02-16-infra-discovery-skill-design.md.', 'progress');
```
