# Runbook: Agent-Group Teardown

**Tool:** `scripts/delete-agent-group.ts`
**Library:** `src/teardown/agent-group-teardown.ts`
**Tests:** `src/teardown/agent-group-teardown.test.ts`
**Related:** [db-central.md](../db-central.md) · [state-discovery.md](../state-discovery.md) · [db-session.md](../db-session.md)

Deleting an agent group is a multi-step teardown across three stores (central DB,
filesystem, container runtime) plus the OneCLI vault. This runbook is the
authoritative deletion order; the tool implements it.

---

## TL;DR

```bash
# 1. Plan. Changes nothing. Read it.
pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id>

# 2. Execute.
pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id> --yes
```

`--folder <name>` works too, but only while the `agent_groups` row still exists —
folder lookups go through that row. A resumed or partial teardown must use `--id`.

Flags: `--yes` (execute), `--keep-onecli`, `--keep-images`.

The tool is idempotent. Re-running after a partial failure re-plans against
whatever is left ("residual mode") and finishes the job.

---

## Why `ncl groups delete` does not do this

`ncl groups delete` was registered through `genericDelete` (`src/cli/crud.ts`) —
a bare `DELETE FROM agent_groups` with `foreign_keys = ON`. Any group that has
ever been wired or run has rows in `messaging_group_agents`, `sessions`,
`agent_destinations`, `agent_group_members` or `user_roles`, all of which block.
It also cannot reach the state that has no FK at all.

The verb now fails fast with a message pointing here instead of surfacing a raw
SQLite error (`deleteHandler` in `src/cli/resources/groups.ts`). It is not wired
to run the teardown, deliberately: under `cli_scope: group` a container agent
gets `--id` auto-filled to its own group, which would make the verb an
agent-self-destruct button. Teardown stays an operator action on the host.

---

## Deletion order, with FK evidence

Evidence is `pragma_foreign_key_list(<table>)` on `data/v2.db`. `foreign_keys =
ON` is set on every connection (`src/db/connection.ts`). The tool recomputes the
blocking sets at runtime (`agentGroupIdTables`, `sessionBlockerTables`,
`cascadesOnAgentGroup`) so a new migration cannot silently add a blocker it does
not know about.

| # | Step | Why here |
|---|------|----------|
| 1 | **Stop running containers** (`docker stop`) | A live container keeps writing to `inbound.db`/`outbound.db` and can respawn work against rows you are about to delete. Names match `nanoclaw-v2-<folder>-<timestamp>` and carry the `nanoclaw-install=<slug>` label. |
| 2 | **`messaging_group_agents`** where `agent_group_id = <id>` | Wiring first: it stops inbound routing immediately, so nothing new arrives mid-teardown. FK → `agent_groups` is `NO ACTION` (blocks). |
| 3 | **Session-scoped blockers**, keyed by session id | `pending_questions.session_id` and `pending_approvals.session_id` both reference `sessions(id)` with `NO ACTION`. **Neither table has an `agent_group_id` column** (`pending_approvals` has one *as well*, `pending_questions` has none), so a sweep on that column misses them and step 4 throws. |
| 4 | **`sessions`** where `agent_group_id = <id>` | Must precede the `agent_groups` delete; `sessions.agent_group_id` is `NO ACTION`. |
| 5 | **`agent_destinations` where `target_id = <id>` and `agent_group_id != <id>`** | Inbound edges from *other* groups. `target_id` is polymorphic (a messaging group id **or** an agent group id, per `target_type`) so it carries **no FK**. Nothing errors if you skip this — the referring agent simply breaks at `send_message` time later. |
| 6 | **Sweep every remaining table carrying `agent_group_id`** | Today: `agent_destinations` (this group's own outbound), `agent_group_members`, `container_configs`, `messaging_group_agents`, `pending_approvals`, `pending_channel_approvals`, `pending_sender_approvals`, `sessions`, `unregistered_senders`, `user_roles`. `unregistered_senders.agent_group_id` and `.messaging_group_id` are bare `TEXT` with no `REFERENCES` — they would never block, and are the rows a careless teardown leaves behind. |
| 7 | **`agent_groups`** | `container_configs.agent_group_id` is the **only** `ON DELETE CASCADE` in the central DB; everything else had to be cleared above. |
| 8 | **`rm -rf groups/<folder>/` and `data/v2-sessions/<agent-group-id>/`** | After the rows, so a crash between 7 and 8 leaves recoverable data rather than orphaned rows. See "Root-owned mount stubs" below. |
| 9 | **`docker rmi <base>:<agent-group-id>`** | Per-group image tag, `nanoclaw-agent-v2-<install-slug>:<agent-group-id>` (`src/install-slug.ts`). Only groups that ever built one have a tag. |
| 10 | **`onecli agents delete --id <onecli-agent-id>`** | Auto-created by `ensureAgent` on first spawn (`src/container-runner.ts`), never removed otherwise, so the vault accumulates orphan agents holding real credentials. Identifier = the agent group id, `ag-`-prefixed when the id starts with a digit. Deleting the agent removes its **secret assignments** only — shared vault secrets survive. The default agent is never touched. |

Steps 2–7 run in a single SQLite transaction. Steps 1 and 8–10 are best-effort
and re-runnable; failures surface in the `WARNINGS` block and the script still
exits 0 (the DB half either fully applied or fully rolled back).

---

## What the tool reports but never touches

### Per-session destination mirrors

Each session's `inbound.db` holds a `destinations` projection of the central
`agent_destinations` table. **Do not hand-edit these files.**

`spawnContainer` calls `writeDestinations` → `replaceDestinations`
(`src/db/session-db.ts`), a transactional `DELETE FROM destinations` + re-insert,
unconditionally on every wake — so any hand edit is overwritten on the next
spawn. And `routeAgentMessage` (`src/modules/agent-to-agent/agent-route.ts`)
re-validates against the **central** table before routing. Fixing step 5 above is
therefore sufficient; the mirrors self-heal. The tool lists them so you know they
exist until each session next wakes.

### Prose references in surviving groups

The tool greps every surviving `groups/*/CLAUDE*.md` for the deleted group's
name, plus the `local_name` each surviving group used for it, and prints
`file:line`. This is the check that catches instructions like "querying <group>
is mandatory" that outlive the group. **Edit those files by hand** — nothing
about intent in prose is safely automatable.

### Orphans

Reported, never deleted:

- **Messaging groups** with no wiring — distinguishing "already had none" from
  "would have none after this teardown". Decide per channel: a DM messaging group
  is usually worth keeping for reuse; a dedicated channel usually is not.
- **Session directories** under `data/v2-sessions/` with nothing backing them —
  no `agent_groups` row, no `sessions` rows for the group, or no `sessions` row
  for that specific session directory.

---

## Root-owned mount stubs

Retired session directories can contain empty bind-mount targets (`extra/<name>`,
`extra/code/`, `group/`) created by Docker as `root:root`. A host-user `rm -rf`
throws `EACCES` and leaves an orphan skeleton behind, and `sudo` is not available
non-interactively.

`removeDirectory` handles this **conditionally** — it only fires on
`EACCES`/`EPERM`/`ENOTEMPTY`, because most groups never hit it. The fallback
mounts the directory into a throwaway `alpine:3` container as uid 0, empties it
from the inside (`find /target -mindepth 1 -delete`), then `rmdir`s the now-empty
mount point from the host. The step is reported as
`remove-directory: <path> (via throwaway container)`.

---

## Safety properties

- **Plan by default.** Nothing is destructive without `--yes`.
- **Every directory removal is keyed on the exact target id.** `assertSafePath`
  re-derives `<root>/<expected-name>` and refuses anything else, immediately
  before each `rm`. Removing a surviving group's session directory would be
  unrecoverable.
- **Container matching is anchored**: `^nanoclaw-v2-<folder>-\d+$`, so folder
  `foo` never matches container `nanoclaw-v2-foo-2-<ts>`.
- **Image matching is exact**: only `<base>:<agent-group-id>` that actually
  exists in `docker images`, plus a config-recorded `image_tag` when it ends in
  `:<agent-group-id>`.
- **No secrets in output.** `onecli agents list` returns `accessToken` per agent;
  only `id`/`name`/`identifier` ever reach the plan.

---

## Manual fallback

If the tool is unavailable, run the same order by hand. Reads go through the
in-tree wrapper, never the `sqlite3` binary:

```bash
G=<agent-group-id>
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM sessions WHERE agent_group_id = '$G'"
# then, in order: messaging_group_agents → pending_questions/pending_approvals (by session id)
#   → sessions → agent_destinations WHERE target_id='$G' → the agent_group_id sweep → agent_groups
```

Regenerate the sweep list rather than trusting a hard-coded one:

```sql
SELECT DISTINCT m.name FROM sqlite_master m
JOIN pragma_table_info(m.name) p ON p.name = 'agent_group_id'
WHERE m.type = 'table' AND m.name != 'agent_groups';
```
