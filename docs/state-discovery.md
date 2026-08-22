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

# OneCLI vault agents with no matching agent group.
# Encodes the exact identifier rule from src/container-runner.ts:136-140:
#   identifier = agentGroup.id            if agentGroup.id starts with a letter
#              = "ag-" + agentGroup.id    otherwise (OneCLI requires identifiers to start with a letter)
# "default" is the built-in agent (no agent group, not an orphan by design).
# An agent_groups row with no matching identifier is normal too — it just never spawned a container yet.
onecli_json=$(onecli agents list --fields=identifier,name,secretMode)   # never use plain `onecli agents list` in a paste — it includes accessToken
groups_tsv=$(pnpm exec tsx scripts/q.ts data/v2.db "select id, name from agent_groups")

python3 - "$onecli_json" "$groups_tsv" <<'PY'
import json, re, sys
onecli = json.loads(sys.argv[1])
groups = [line.split("|", 1) for line in sys.argv[2].strip().splitlines() if line.strip()]

def expected_identifier(gid):
    return gid if re.match(r'^[a-zA-Z]', gid) else f"ag-{gid}"

expected = {expected_identifier(gid): (gid, gname) for gid, gname in groups}
orphans = [a for a in onecli if a["identifier"] != "default" and a["identifier"] not in expected]

if orphans:
    print(f"ORPHANS FOUND: {len(orphans)}")
    for o in orphans:
        print(f"  identifier={o['identifier']} name={o['name']} secretMode={o['secretMode']}")
    sys.exit(1)

print(f"OK: 0 orphans. {len(onecli)} onecli agents (incl. default) reconcile against {len(groups)} agent_groups rows.")
unspawned = [gname for gid, gname in groups if expected_identifier(gid) not in {a['identifier'] for a in onecli}]
if unspawned:
    print(f"NOTE: no vault agent yet for (never spawned a container — not an orphan): {', '.join(unspawned)}")
PY
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

**Blocks** — eight of the ten `agent_group_id` tables declare a plain `REFERENCES agent_groups(id)` with no `ON DELETE` clause (i.e. `NO ACTION`): `agent_destinations`, `agent_group_members`, `messaging_group_agents`, `pending_approvals`, `pending_channel_approvals`, `pending_sender_approvals`, `sessions`, `user_roles`. Deleting a group that still has rows in any of them raises an FK error. This is why `ncl groups delete` — a bare `DELETE` in `genericDelete` (`src/cli/crud.ts:200`) — fails for any group that has ever been wired or run.

**Blocks a _session_ delete, from a direction group-scoped sweeps miss** — two FKs point at `sessions` rather than `agent_groups`. Neither table has an `agent_group_id` column, so neither shows up in the ten-table sweep above, and both will refuse a `DELETE FROM sessions`:

| Reference | On delete |
|---|---|
| `pending_questions.session_id` | `NO ACTION` → blocks (`src/db/migrations/001-initial.ts:101`) |
| `pending_approvals.session_id` | `NO ACTION` → blocks |

`pending_approvals` carries *both*: an `agent_group_id` FK to `agent_groups` and a `session_id` FK to `sessions`. Clear these before deleting session rows — see teardown step 4.

**Silently dangles** — three references have no FK at all and will never error:

| Reference | Why there is no FK |
|---|---|
| `agent_destinations.target_id` | Polymorphic: holds a messaging group id *or* an agent group id depending on `target_type` |
| `destinations.agent_group_id` in each session's `inbound.db` | Different SQLite file; cross-file FKs are impossible |
| `unregistered_senders.agent_group_id` | Declared as a bare `TEXT` column with no `REFERENCES` clause (`src/db/migrations/008-dropped-messages.ts:16`). It is the one `agent_group_id` table that will *not* block a group delete — and the one a sweep is most likely to leave behind |

Practical consequence: a group-scoped sweep removes a group's *outbound* edges but never the *inbound* ones. Other groups keep pointing at the deleted group, and the breakage surfaces at runtime rather than at delete time.

### Teardown order

Implemented by `scripts/delete-agent-group.ts` (plan by default, `--yes` to execute).
Stop the host service first — the 60s sweep runs throughout otherwise.
Exit codes: `0` complete, `1` usage/resolution error, `2` executed but incomplete.
Authoritative writeup, with the FK evidence per step: [runbooks/agent-group-teardown.md](runbooks/agent-group-teardown.md).

```
1. kill running containers for the group's sessions
2. delete agent_destinations rows in OTHER groups where target_id = this group   (no FK — must be hunted)
3. clear destinations rows in OTHER groups' session inbound.db files             (different DB — must be hunted)
4. clear pending_questions AND pending_approvals for this group's sessions       (both FK sessions; pending_questions has no agent_group_id column)
5. delete rows in the ten agent_group_id tables
6. delete the agent_groups row
7. rm -rf groups/<folder>/
8. rm -rf data/v2-sessions/<agent-group-id>/
9. remove the per-group docker image tag
10. delete the OneCLI vault agent and its secret assignments
11. decide on now-orphaned messaging groups
12. edit prose references in surviving groups' CLAUDE.md / CLAUDE.local.md       (not automatable)
```

Steps 1–11 are implemented by `scripts/delete-agent-group.ts`, with the caveat that steps 3 and 11 are **reported, not performed**: per-session `destinations` mirrors self-heal on the next `spawnContainer` (`writeDestinations` → `replaceDestinations` is an unconditional `DELETE` + re-insert), and orphaned messaging groups are a judgement call. Step 12 is not automatable, but the tool greps surviving `groups/*/CLAUDE*.md` and `groups/*/skills/*/SKILL.md` for the deleted group's name and for the `local_name`s other groups used for it, and prints `file:line`.

Step 7 is the one a resumed run cannot finish on its own: the folder lived only in the `agent_groups` row, so once that row is gone pass `--id <id> --folder <name>` together. Without it the tool reports `folder unknown` and exits `2`.

`scripts/delete-cli-agent.ts` — named for setup's ping-pong scratch agent but always generic — is now a deprecated shim delegating to the same code, kept because `setup/auto.ts` invokes it by name.

### Where a group's state lives

| Location | Keyed by | Notes |
|---|---|---|
| `data/v2.db` rows | agent group id | The ten tables above |
| `groups/<folder>/` | `agent_groups.folder` | CLAUDE.md, CLAUDE.local.md, `.claude-fragments/`, skills, materialized `container.json` |
| `data/v2-sessions/<agent-group-id>/<session-id>/` | agent group id, then session id | `inbound.db` + `outbound.db`; can outlive its `sessions` row |
| Docker image tag | `nanoclaw-agent-v2-<install-slug>:<agent-group-id>` | Slug is derived from the project root path (`src/install-slug.ts:27`) so parallel installs on one host don't clobber each other. Only groups that have been built have a tag |
| OneCLI vault agent | `identifier` = agent group id | Auto-created by `ensureAgent` on first spawn (`src/container-runner.ts:429`). Identifiers must start with a letter, so ids beginning with a digit get an `ag-` prefix (`src/container-runner.ts:139-140`) — `54c8dbdf-…` becomes `ag-54c8dbdf-…`, while `f09aa5a1-…` is used as-is. As of TASK-14/29, removed automatically as step 10 of `scripts/delete-agent-group.ts` teardown — see below |

### OneCLI vault agent audit (2026-08-22)

Ran the reconcile snippet above and cross-checked by hand against `select id, name from agent_groups`. Result: **zero orphans.** `onecli agents list` returned exactly four agents; every non-default one maps to a live `agent_groups` row via the identifier rule:

| OneCLI identifier | name | agent_groups id | agent_groups name | secretMode |
|---|---|---|---|---|
| `default` | Default Agent | — (built-in, no agent group) | — | all |
| `ag-740a6fb3-5aff-42e8-b5dd-0a8a57d6b4a5` | Radar | `740a6fb3-5aff-42e8-b5dd-0a8a57d6b4a5` | Radar | all |
| `ag-1782273071167-th1q6f` | Aurora | `ag-1782273071167-th1q6f` | Aurora | all |
| `ag-1779381936325-6ki38t` | Mjollnir | `ag-1779381936325-6ki38t` | Mjollnir | all |

`local-qwen3.6` (`103c34dd-8610-4bd6-9fa0-b9b98f79941d`) has no vault agent — it has never spawned a container, so that is expected, not an orphan.

The three orphans named in TASK-16's original description (Memory, Coder, Terminal Agent) are already gone; they were cleaned up by earlier teardown work (TASK-10/11/12) before this audit ran.

**Secret assignment audit.** `onecli secrets list` shows exactly one vault secret: `6387482f-2fac-4ce4-a1bf-eb34633576b3` ("Anthropic", type `anthropic`, host pattern `api.anthropic.com`). `onecli agents secrets --id <id>` for each of Radar, Aurora, and Mjollnir returns that one secret id explicitly assigned; Default Agent's assignment list is empty. No assignment references a non-existent agent — AC#2 holds with nothing to clean up.

**secretMode: all, given one vault secret.** Every non-default agent has `secretMode: "all"` — any vault secret whose host pattern matches gets injected into every request from that agent, no per-agent opt-in. With exactly one secret in the vault, `all` and "selective, assigned to that one secret" are **functionally identical today** — there's nothing else it could inject. That equivalence breaks the moment a second secret is added: a new credential with a matching host pattern would auto-flow into Radar, Aurora, and Mjollnir with no additional step, whether or not that agent's task needs it. Whether `all` is still the intended posture once the vault holds more than one secret is a decision reserved for the human (see the CLAUDE.md gotcha "Gotcha: auto-created agents start in `selective` secret mode" for the flip side — these agents were presumably moved off `selective` deliberately to unblock 401s, and that choice hasn't been revisited since).

### Vault-agent orphans: where the guarantee now lives

TASK-14 added, and TASK-29 hardened, deletion of the OneCLI vault agent as **step 10** of `scripts/delete-agent-group.ts` teardown (`src/teardown/agent-group-teardown.ts`, `onecliAgent` deletion around line 1020-1023: `onecli agents delete --id <id>`, removing the agent and its secret assignments — shared vault secrets themselves survive). Critically, the tool does not just skip this step silently when it can't confirm: `findOnecliAgent` (`src/teardown/agent-group-teardown.ts:624-666`) treats a failed exec, unparseable JSON, or an unexpected response shape from `onecli agents list` as `unknown: true`, distinct from "no vault agent exists" (`agent: null`). That propagates to the plan's `onecliUnknown` flag, which `collectIncomplete` (`scripts/delete-agent-group.ts:153`) surfaces as an incomplete-teardown line, driving `process.exit(2)` — "executed but incomplete" — rather than a silent exit 0. So a run that can't verify the vault-agent state cannot report success.

Net effect: the orphan class this task was filed against is now closed **at the source** — a group deleted through the standard teardown path cannot leave its vault agent behind without also leaving a nonzero exit code. The reconcile snippet above is a **backstop** (catches manual `ncl groups delete` on an unwired group, `onecli` outages during a past teardown, or drift from before TASK-14 existed) rather than the primary control.

### Scheduling is session-scoped and wiring-independent

Two facts that together produce the most surprising behavior in the system:

- A recurring task is a row in **one session's** `messages_in`, carrying that session's `channel_type` / `platform_id`. Move the conversation to another channel and the schedule does not follow.
- `host-sweep` wakes sessions from `getActiveSessions()` (`src/host-sweep.ts:136`) and **never consults `messaging_group_agents`**.

So deleting a wiring stops inbound messages while that session's schedule keeps firing and keeps posting outbound to the old channel. Wiring lifecycle and schedule lifecycle are independent — when retiring a channel, handle the schedule explicitly.

### Privilege model, in one line each

- `user_roles` — owner / admin, global (`agent_group_id` NULL) or scoped to a group. Approver resolution walks scoped admins → global admins → owners.
- `agent_group_members` — unprivileged access gate. Per-channel identity: Discord owner rights do **not** extend to the same human's Matrix identity.
- There is no env var for admins. Roles live in the central DB only.
