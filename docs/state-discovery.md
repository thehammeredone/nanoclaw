# State Discovery

How to get an accurate picture of what this install actually contains — which agent groups exist, what they are wired to, what depends on what — without rediscovering the same things every session.

The material here splits in two, and the split is the point:

- **Volatile** — anything that changes as agents get created, wired, or retired. This doc stores the **command**, never the answer. Copy the query, run it, trust the output.
- **Stable** — structure that only changes when someone edits the schema or the runner. This doc stores the **data inline**, because re-deriving it costs a dozen commands and it will still be true next month.

Companion docs: [db.md](db.md) (three-DB model), [db-central.md](db-central.md) (every central table), [db-session.md](db-session.md) (per-session schemas).

---

## Querying: use `scripts/q.ts`

```bash
pnpm exec tsx scripts/q.ts <db-path> "<sql>"
```

Never the `sqlite3` CLI — setup deliberately does not depend on that binary (`setup/verify.ts:5`). The wrapper goes through `better-sqlite3`, which setup already installs and verifies.

Three databases:

| Path | Holds |
|------|-------|
| `data/v2.db` | Everything not per-session: groups, wirings, users, roles, destinations, container configs |
| `data/v2-sessions/<agent-group-id>/<session-id>/inbound.db` | `messages_in`, `destinations`, `session_routing`, `delivered` |
| `data/v2-sessions/<agent-group-id>/<session-id>/outbound.db` | `messages_out`, `session_state` |

### Gotchas that cost real time

**Duplicate column names collapse.** Output is built from row objects, so two columns named `name` in a join silently leave you with only the last one. Alias every column in a join:

```sql
-- WRONG: ag.name is lost, mg.name wins, and nothing warns you
select ag.name, mg.name from ... 
-- RIGHT
select ag.name as agent, mg.name as mgname from ...
```

**Output is pipe-separated with no header.** Column order in the SELECT is your only key to reading the result. Keep selects short and ordered deliberately.

**Errors dump a full Node stack trace.** A wrong column name produces ~10 lines of noise. Pipe through `| tail -20` by default, or the real error scrolls away.

**Read the schema, don't guess the column.** Names that look obvious and are not:

| You will type | It is actually | Table |
|---|---|---|
| `folder_name` | `folder` | `agent_groups` |
| `due_at` | `process_after` | `messages_in` |
| `config` (a JSON blob) | typed columns + separate JSON-text columns | `container_configs` |

```bash
# list tables
pnpm exec tsx scripts/q.ts data/v2.db "select name from sqlite_master where type='table' order by name"
# read one table's DDL
pnpm exec tsx scripts/q.ts data/v2.db "select sql from sqlite_master where name='agent_groups'"
```

---

## Volatile — capture the call

### Inventory: what agents exist

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "select id, name, folder, agent_provider from agent_groups"
```

### The wiring map (which agent hears which channel)

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "select mga.id as wid, ag.name as agent, ag.id as agid, mg.channel_type as ch,
          mg.name as mgname, mg.id as mgid, mga.session_mode as smode, mga.engage_mode as emode
   from messaging_group_agents mga
   join agent_groups ag on ag.id = mga.agent_group_id
   join messaging_groups mg on mg.id = mga.messaging_group_id"
```

### Sessions per agent

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "select s.id as sid, ag.name as agent, s.messaging_group_id as mgid,
          s.thread_id as thread, s.status, s.container_status
   from sessions s join agent_groups ag on ag.id = s.agent_group_id"
```

### The destination graph (who can message whom)

`local_name` is the label the agent uses in `send_message to="..."`. `target_type` is `channel` or `agent`.

```bash
pnpm exec tsx scripts/q.ts data/v2.db "select * from agent_destinations"
```

### Every schedule in the install

Recurrence is **per-session**, not central. There is no one table to read — you have to sweep the session DBs:

```bash
for d in data/v2-sessions/*/*/inbound.db; do
  r=$(pnpm exec tsx scripts/q.ts "$d" \
    "select count(*) from messages_in
     where recurrence is not null or (status='pending' and process_after is not null)" 2>/dev/null | tail -1)
  [ "$r" != "0" ] && echo "$d -> $r"
done
```

Then read the hits:

```bash
pnpm exec tsx scripts/q.ts <inbound.db> \
  "select id, status, process_after, recurrence, series_id, channel_type, substr(content,1,200)
   from messages_in where recurrence is not null"
```

### Mirrored per-session destinations

Each session's `inbound.db` carries a copy of that group's destinations. Stale copies are a real failure mode after a group is deleted:

```bash
for d in data/v2-sessions/*/*/inbound.db; do
  echo "$d :: $(pnpm exec tsx scripts/q.ts "$d" "select group_concat(name) from destinations" 2>/dev/null | tail -1)"
done
```

### Orphan detection (found real orphans; run it periodically)

```bash
# group folders on disk with no agent_groups row
ls groups/
pnpm exec tsx scripts/q.ts data/v2.db "select folder from agent_groups"

# session dirs on disk with no sessions row
ls data/v2-sessions/
pnpm exec tsx scripts/q.ts data/v2.db "select distinct agent_group_id from sessions"

# messaging groups with no wiring
pnpm exec tsx scripts/q.ts data/v2.db \
  "select mg.id, mg.channel_type, mg.name from messaging_groups mg
   left join messaging_group_agents mga on mga.messaging_group_id = mg.id
   where mga.id is null"

# OneCLI vault agents with no matching agent group
onecli agents list | grep -E '"name"|"identifier"'
```

### Docker + OneCLI state

```bash
docker images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
onecli agents list
```

---

## Stable — the data, recorded

### Tables carrying `agent_group_id`

Ten, and this list is what any group-scoped sweep iterates:

```
messaging_group_agents   user_roles              agent_group_members
sessions                 pending_approvals       agent_destinations
unregistered_senders     pending_sender_approvals
pending_channel_approvals                        container_configs
```

Regenerate it (it is cheap, and `scripts/delete-cli-agent.ts` computes it the same way):

```sql
SELECT DISTINCT m.name FROM sqlite_master m
JOIN pragma_table_info(m.name) p ON p.name = 'agent_group_id'
WHERE m.type = 'table' AND m.name != 'agent_groups'
```

### Foreign keys: what blocks, what cascades, what silently dangles

`foreign_keys = ON` is set on every connection (`src/db/connection.ts:18,26`). Three distinct behaviors, and the third is the one that bites:

**Cascades** — `container_configs.agent_group_id` is the only `ON DELETE CASCADE` in the central DB. It disappears on its own.

**Blocks** — every other `agent_group_id` reference is a plain `REFERENCES agent_groups(id)`. Deleting a group that still has rows in `sessions`, `messaging_group_agents`, `agent_destinations`, `agent_group_members`, `user_roles` or the `pending_*` tables raises an FK error. This is why `ncl groups delete` — a bare `DELETE` in `genericDelete` (`src/cli/crud.ts:200`) — fails for any group that has ever been wired or run.

**Silently dangles** — three references have no FK at all and will never error:

| Reference | Why there is no FK |
|---|---|
| `agent_destinations.target_id` | Polymorphic: holds a messaging group id *or* an agent group id depending on `target_type` |
| `destinations.agent_group_id` in each session's `inbound.db` | Different SQLite file; cross-file FKs are impossible |
| `pending_questions.session_id` | Has an FK to `sessions`, but **no `agent_group_id` column** — so it is invisible to group-scoped sweeps and can block a `sessions` delete from a direction you did not look |

Practical consequence: a group-scoped sweep removes a group's *outbound* edges but never the *inbound* ones. Other groups keep pointing at the deleted group, and the breakage surfaces at runtime rather than at delete time.

### Teardown order

```
1. kill running containers for the group's sessions
2. delete agent_destinations rows in OTHER groups where target_id = this group   (no FK — must be hunted)
3. clear destinations rows in OTHER groups' session inbound.db files             (different DB — must be hunted)
4. clear pending_questions for this group's sessions                             (no agent_group_id column)
5. delete rows in the ten agent_group_id tables
6. delete the agent_groups row
7. rm -rf groups/<folder>/
8. rm -rf data/v2-sessions/<agent-group-id>/
9. delete the OneCLI vault agent and its secret assignments
10. remove the per-group docker image tag
11. decide on now-orphaned messaging groups
12. edit prose references in surviving groups' CLAUDE.md / CLAUDE.local.md       (not automatable)
```

Steps 5–8 are what `scripts/delete-cli-agent.ts --folder <folder>` already does. Despite its name it is fully generic — it is the closest thing to a working teardown. Steps 1–4 and 9–12 are unimplemented today.

### Where a group's state lives

| Location | Keyed by | Notes |
|---|---|---|
| `data/v2.db` rows | agent group id | The ten tables above |
| `groups/<folder>/` | `agent_groups.folder` | CLAUDE.md, CLAUDE.local.md, `.claude-fragments/`, skills, materialized `container.json` |
| `data/v2-sessions/<agent-group-id>/<session-id>/` | agent group id, then session id | `inbound.db` + `outbound.db`; can outlive its `sessions` row |
| Docker image tag | `nanoclaw-agent-v2-<install-slug>:<agent-group-id>` | Slug is derived from the project root path (`src/install-slug.ts:27`) so parallel installs on one host don't clobber each other. Only groups that have been built have a tag |
| OneCLI vault agent | `identifier` = agent group id | Auto-created by `ensureAgent` on first spawn (`src/container-runner.ts:385`). Identifiers must start with a letter, so ids beginning with a digit get an `ag-` prefix (`src/container-runner.ts:139`) — `54c8dbdf-…` becomes `ag-54c8dbdf-…`, while `f09aa5a1-…` is used as-is. Never removed automatically |

### Scheduling is session-scoped and wiring-independent

Two facts that together produce the most surprising behavior in the system:

- A recurring task is a row in **one session's** `messages_in`, carrying that session's `channel_type` / `platform_id`. Move the conversation to another channel and the schedule does not follow.
- `host-sweep` wakes sessions from `getActiveSessions()` (`src/host-sweep.ts:136`) and **never consults `messaging_group_agents`**.

So deleting a wiring stops inbound messages while that session's schedule keeps firing and keeps posting outbound to the old channel. Wiring lifecycle and schedule lifecycle are independent — when retiring a channel, handle the schedule explicitly.

### Privilege model, in one line each

- `user_roles` — owner / admin, global (`agent_group_id` NULL) or scoped to a group. Approver resolution walks scoped admins → global admins → owners.
- `agent_group_members` — unprivileged access gate. Per-channel identity: Discord owner rights do **not** extend to the same human's Matrix identity.
- There is no env var for admins. Roles live in the central DB only.
