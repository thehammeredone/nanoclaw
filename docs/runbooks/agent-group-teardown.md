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
# 0. Stop the host. The 60s sweep runs the whole time otherwise.
systemctl --user stop nanoclaw-v2-b3501fc6          # Linux (this install)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist   # macOS

# 1. Plan. Changes nothing. Read it.
pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id>

# 2. Execute. Check the exit code.
pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id> --yes; echo "exit=$?"

# 3. Start the host again.
systemctl --user start nanoclaw-v2-b3501fc6         # Linux (this install)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist     # macOS
```

`--folder <name>` on its own resolves the group, but only while the
`agent_groups` row still exists — folder lookups go through that row.

Flags: `--yes` (execute), `--folder <name>`, `--keep-onecli`, `--keep-images`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Plan printed (dry run), or executed with **every** step complete. |
| `1` | Usage error, or the target could not be resolved. Nothing ran. |
| `2` | Executed but **incomplete**. The DB half committed; at least one of the group directory, session directory, image tag, container stop or OneCLI vault agent was not dealt with — including cases where discovery itself failed (e.g. `docker`/`onecli` unreachable; `onecli` exiting 0 with output that cannot be parsed or is not the expected shape; or the container runtime exiting 0 with output that doesn't match the requested `--format` template's shape — a human-readable table, compact JSON, or anything else — see below), which counts as incomplete even though nothing was "attempted and failed" in the usual sense. The `INCOMPLETE` block lists what. |

Never read `2` as success. The dangerous residue is the OneCLI vault agent: it
still holds injectable credentials for a group that no longer exists.

### What re-running does and does not recover

Re-running re-plans against whatever is left ("residual mode"). It **does**
recover: the DB sweep, `data/v2-sessions/<agent-group-id>/` (keyed on the id you
pass), the image tag, and the OneCLI vault agent.

It **does not** recover `groups/<folder>/` on its own. The folder lived only in
the `agent_groups` row, and that row is gone after the first run — residual mode
has nothing to resolve it from. You must supply it:

```bash
pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id> --folder <name> --yes
```

`--folder` supplements `--id` **only** in residual mode (while the row exists the
DB is authoritative). It goes through the same `assertSafePath` guard as every
other folder value, so a traversal attempt is refused rather than followed —
and it is checked against `agent_groups` for a surviving owner, so a typo'd
`--folder` naming a still-live group's directory is refused rather than
silently torn down. Without a usable `--folder`, residual mode reports `folder
unknown` and exits `2`.

Container discovery is also folder-keyed, so a residual run without `--folder`
cannot stop containers either — it prints `WILL STOP — (COULD NOT CHECK …)`
rather than `(none)`.

---

## Stop the host first

Steps 0 and 3 above are not ceremony. The host sweep (`src/host-sweep.ts`) runs
every 60 seconds for the whole life of the process and, independently of this
tool, syncs `processing_ack`, detects stale sessions, wakes sessions with due
messages, and inserts recurrences. A wake mid-teardown can spawn a container
against rows you are in the middle of deleting, and that container then writes
into a session directory that step 8 is about to `rm -rf`. Channel adapters are
live too, so an inbound message can create routing rows after the wiring delete.

The tool does not coordinate with the sweep — deliberately. There is no lock to
take, and inventing one would put teardown-specific logic on the hot path. The
operator stops the service instead; it is a single deliberate action for the
duration of one teardown.

Service name on this install is `nanoclaw-v2-b3501fc6` (confirm with
`systemctl --user list-units 'nanoclaw*'` — the slug is per-install).

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

The verb is registered as `open`, not `approval`, for the same reason. `dispatch`
requests approval *before* invoking a handler, so `approval` would DM a human
admin "Agent X wants to run: `ncl groups delete --id <its own group>`" and then
throw anyway once approved. The refusal short-circuits ahead of that round-trip.

---

## Deletion order, with FK evidence

Evidence is `pragma_foreign_key_list(<table>)` on `data/v2.db`. `foreign_keys =
ON` is set on every connection (`src/db/connection.ts`). The tool recomputes the
blocking sets at runtime (`agentGroupIdTables`, `sessionBlockerTables`,
`cascadesOnAgentGroup`) so a new migration cannot silently add a blocker it does
not know about.

| # | Step | Why here |
|---|------|----------|
| 1 | **Stop running containers** (`<runtime> stop`) | A live container keeps writing to `inbound.db`/`outbound.db` and can respawn work against rows you are about to delete. Names match `nanoclaw-v2-<folder>-<timestamp>` and carry the `nanoclaw-install=<slug>` label. Discovery is folder-keyed: no folder means no discovery, reported as `COULD NOT CHECK`, never as `(none)`. |
| 2 | **`messaging_group_agents`** where `agent_group_id = <id>` | Wiring first: it stops inbound routing immediately, so nothing new arrives mid-teardown. FK → `agent_groups` is `NO ACTION` (blocks). |
| 3 | **Session-scoped blockers**, keyed by session id | `pending_questions.session_id` and `pending_approvals.session_id` both reference `sessions(id)` with `NO ACTION`. **Neither table has an `agent_group_id` column** (`pending_approvals` has one *as well*, `pending_questions` has none), so a sweep on that column misses them and step 4 throws. |
| 4 | **`sessions`** where `agent_group_id = <id>` | Must precede the `agent_groups` delete; `sessions.agent_group_id` is `NO ACTION`. |
| 5 | **`agent_destinations` where `target_type = 'agent'` and `target_id = <id>` and `agent_group_id != <id>`** | Inbound edges from *other* groups. `target_id` is polymorphic (a messaging group id **or** an agent group id, per `target_type`) so it carries **no FK** — and is only meaningful together with its type filter, which is why both the read and the DELETE carry it, matching `getDestinationReferencers` (`src/modules/agent-to-agent/db/agent-destinations.ts`). Nothing errors if you skip this step — the referring agent simply breaks at `send_message` time later. |
| 6 | **Sweep every remaining table carrying `agent_group_id`** | Today: `agent_destinations` (this group's own outbound), `agent_group_members`, `container_configs`, `messaging_group_agents`, `pending_approvals`, `pending_channel_approvals`, `pending_sender_approvals`, `sessions`, `unregistered_senders`, `user_roles`. `unregistered_senders.agent_group_id` and `.messaging_group_id` are bare `TEXT` with no `REFERENCES` — they would never block, and are the rows a careless teardown leaves behind. |
| 7 | **`agent_groups`** | `container_configs.agent_group_id` is the **only** `ON DELETE CASCADE` in the central DB; everything else had to be cleared above. |
| 8 | **`rm -rf groups/<folder>/` and `data/v2-sessions/<agent-group-id>/`** | After the rows, so a crash between 7 and 8 leaves recoverable data rather than orphaned rows. See "Root-owned mount stubs" below. |
| 9 | **`<runtime> rmi <base>:<agent-group-id>`** | Per-group image tag, `nanoclaw-agent-v2-<install-slug>:<agent-group-id>` (`src/install-slug.ts`). Only groups that ever built one have a tag. |
| 10 | **`onecli agents delete --id <onecli-agent-id>`** | Auto-created by `ensureAgent` on first spawn (`src/container-runner.ts`), never removed otherwise, so the vault accumulates orphan agents holding real credentials. Identifier = the agent group id, `ag-`-prefixed when the id starts with a digit. Deleting the agent removes its **secret assignments** only — shared vault secrets survive. The default agent is never touched. |

Steps 2–7 run in a single SQLite transaction (fully applied or fully rolled
back). Steps 1 and 8–10 are not transactional: each is re-runnable, but a
failure in any of them means the teardown is unfinished, so it is listed in the
`INCOMPLETE` block and the script exits **2**.

Every container-runtime shell-out in steps 1, 8 (root-owned-stub fallback) and 9
goes through `CONTAINER_RUNTIME_BIN` (`src/container-runtime.ts`), so the
`/convert-to-apple-container` swap remains a one-file change. It is called via
the injected `env.exec` rather than that module's `stopContainer()` helper for
three reasons: teardown must turn a failed stop into a reported warning, and
`stopContainer` throws instead of returning a result; `stopContainer` hardcodes
`-t 1` where teardown deliberately uses `-t 5` so a container gets a chance to
flush its outbound DB; and `env.exec` is what keeps the tests from ever
shelling out.

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

The tool greps every surviving group's instruction files for the deleted group's
name, plus the `local_name` each surviving group used for it, and prints
`file:line`. Two shapes are scanned, deliberately bounded (a recursive walk
would drag in workspaces, caches and checked-out repos):

- `groups/<folder>/CLAUDE*.md`
- `groups/<folder>/skills/<skill>/SKILL.md` — per-group skills are group
  instructions too, and a "querying `<group>` is mandatory" line in one outlives
  the group just as readily.

This is the check that catches instructions that outlive the group. **Edit those
files by hand** — nothing about intent in prose is safely automatable.

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
mounts the directory into a throwaway `alpine:3` container as uid 0 (via
`CONTAINER_RUNTIME_BIN`, like every other shell-out), empties it from the inside
(`find /target -mindepth 1 -delete`), then `rmdir`s the now-empty mount point
from the host. The step is reported as
`remove-directory: <path> (via throwaway container)`.

The first `rmSync` passes `force: true`. That swallows `ENOENT` only — `EACCES`
still reaches the fallback above. It exists so an entry that vanishes mid-walk
cannot short-circuit to "could not remove" (`ENOENT` is not one of the three
codes the fallback handles), and to close the `existsSync`/`rmSync` race in the
caller.

---

## Safety properties

- **Plan by default.** Nothing is destructive without `--yes`.
- **Every directory removal is keyed on the exact target id.** `assertSafePath`
  re-derives `<root>/<expected-name>` and refuses anything else, immediately
  before each `rm`. Removing a surviving group's session directory would be
  unrecoverable. In residual mode, an operator-supplied `--folder` additionally
  gets checked against `agent_groups` for a surviving owner — the path guard
  only proves the name is shaped safely, not that nothing else still owns it.
- **The plan never over-promises.** Planning applies the same guard the executor
  applies, so a path that would be refused is printed under `REFUSED —
  filesystem` instead of `WILL DELETE`. An operator approves the plan, so plan
  and execute have to agree.
- **A failed check is not an empty result.** If the container runtime or
  `onecli` is missing or errors, the plan prints `(COULD NOT CHECK …)` for
  containers, docker images, and the OneCLI vault agent — never `(none)`.
  This also covers a `onecli agents list` call that exits 0 but returns output
  that `JSON.parse` cannot handle, or valid JSON that is not the expected
  `{ data: [...] }` shape (a bare array, a scalar, `null`, `{"data":{}}`) —
  that is discovery failing just as surely as a non-zero exit, so it is
  `(COULD NOT CHECK …)` too, not `(none)`. It also covers `<runtime> ps`/`images`
  exiting 0 with something other than the requested `--format` output — a
  human-readable table, or compact JSON (a runtime whose `--format` flag takes
  `json|table` rather than a Go template, e.g. Apple Container, is at least as
  likely to fall back to JSON as to a table). Each line is checked against the
  positive shape the template can actually produce (a bare container name, or
  a `repo:tag` token) rather than against a negative "does this look like a
  table row" heuristic — the negative form only catches column-padded,
  whitespace-containing output and lets whitespace-free garbage (JSON, an
  unpadded single-column header) through. Any line that fails its shape check
  flips the result to `unknown` rather than letting it silently fail the match
  and read as `(none)`
  (TASK-30). Otherwise an operator would approve deleting rows and session
  directories out from under a live container, or leave a vault agent still
  holding injectable credentials for a deleted group. Every one of these
  discovery failures is counted in `collectIncomplete`, so the exit code is
  `2`, not `0`.
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
#   → sessions → agent_destinations WHERE target_type='agent' AND target_id='$G'
#   → the agent_group_id sweep → agent_groups
# ...then rm -rf groups/<folder>/ and data/v2-sessions/$G/, the image tag, and the OneCLI agent.
```

Regenerate the sweep list rather than trusting a hard-coded one:

```sql
SELECT DISTINCT m.name FROM sqlite_master m
JOIN pragma_table_info(m.name) p ON p.name = 'agent_group_id'
WHERE m.type = 'table' AND m.name != 'agent_groups';
```
