---
sid: 9934a222-4185-48a6-8de2-07b8bbe71cf7
pwd: /home/hammer/git/nanoclaw-v2
model: Opus 5
date: 2026-07-30
tags: [work-record]
---

# Work Record — Decommission planning: Aurora Discord wiring and four agent groups

## Purpose / Intent of the session

Hammer wants Aurora detached from Discord (Matrix is now the live path) and four agent groups retired outright: Memory — including its wiki and files — Coder, local-qwen3.6, and Terminal Agent. The ask was explicitly **planning, not execution**: find every place a deletion would touch, then file backlog items covering all of it. Mid-session the scope grew to also capture the discovery process itself, because answering "what would this touch" took ~36 shell commands that should not have to be re-run next time.

## Major steps taken

1. Inventoried the central DB — agent groups, messaging groups, wirings, sessions, destinations, members, roles, container configs — and mapped which rows belong to the four doomed groups.
2. Traced the deletion blast radius through the schema: which tables carry `agent_group_id`, which FKs block vs cascade, which references have no FK at all.
3. Read `src/cli/crud.ts` and `scripts/delete-cli-agent.ts` to establish what teardown tooling actually exists and where it stops.
4. Swept every session `inbound.db` for scheduled/recurring rows and for mirrored `destinations` copies.
5. Found the two landmines: Aurora's 6am schedule lives in the **Discord** session, and Mjollnir's instructions make querying Memory mandatory on every turn.
6. Checked out-of-DB state: docker image tags, OneCLI vault agents, orphan folders and session directories.
7. Filed TASK-7 through TASK-14 with dependencies encoding the safe ordering.
8. On Hammer's follow-up: closed the opencode open question, wrote `docs/state-discovery.md`, and filed the remaining loose ends as their own tasks.

## Major outcomes

- **Aurora's morning brief was one wiring-delete away from silent death.** The recurring row (`0 6 * * *`, series `task-1783352195211-y4arce`) lives in `sess-1782319186963-b2yjgn` — the Discord #skylight session — not in the Matrix session, which has zero scheduled rows.
- **Wiring and schedule lifecycles are independent.** `host-sweep` wakes sessions from `getActiveSessions()` (`src/host-sweep.ts:136`) and never consults `messaging_group_agents`. Deleting a wiring stops inbound while the schedule keeps firing outbound to the dead channel.
- **`ncl groups delete` does not work.** It is `genericDelete` (`src/cli/crud.ts:200`) — a bare `DELETE` with `foreign_keys = ON`, so it throws for any group that has ever been wired or run. The only working teardown is `scripts/delete-cli-agent.ts`, which is fully generic despite its name.
- **Inbound references dangle silently.** `agent_destinations.target_id` is polymorphic and has no FK. Group-scoped sweeps delete a group's outbound edges and leave every *inbound* edge pointing at a corpse — Mjollnir→memory, Mjollnir→coder, Terminal→memory. Breakage would surface at runtime, not at delete time.
- **Deleting Memory before editing prose would break Mjollnir on every message** — `groups/dm-with-hammer/CLAUDE.local.md:11` calls querying `memory` "mandatory, not optional". Aurora has the same section.
- **Nine backlog tasks filed** (TASK-7 … TASK-15) plus loose-end tasks, with dependencies encoding the ordering: schedule migration before Discord teardown; reference purge before group deletion.
- **Discovery cost is now paid down** — `docs/state-discovery.md` records the query recipes for volatile state and the structural data for stable state, and is linked from the CLAUDE.md docs index.
- Nothing was deleted, modified in the DB, or executed against the running install.

## Artifacts

### Git commits

Remote: `https://github.com/nanocoai/nanoclaw.git`

**This session produced no commits.** The table below is the pre-session HEAD lineage the scaffold picked up, not session output.

| Hash | Summary |
|------|---------|
| `348bc4994b4b02ca63258ae4b79b59aba8adb3ed` | docs(aurora): Skylight MCP runbook, add TASK-5 and TASK-6 |
| `b058b745a813350835b187f9bb954f6744cf2ea5` | tune(aurora): single-message Matrix format, multi-profile events, honest failures |
| `b8d0e67d0d3fc33bd8479066a59b4e9f27315ee0` | chore: ignore local editor and skills-system artifacts |

### Uncommitted changes at session end

```
 M CLAUDE.md
?? "backlog/tasks/task-10 - Decommission-the-Memory-agent-group-including-its-wiki.md"
?? "backlog/tasks/task-11 - Decommission-the-Coder-agent-group.md"
?? "backlog/tasks/task-12 - Decommission-the-Terminal-Agent-and-decide-the-fate-of-the-CLI-messaging-group.md"
?? "backlog/tasks/task-13 - Decommission-the-local-qwen3.6-agent-group.md"
?? "backlog/tasks/task-14 - Make-agent-group-teardown-a-first-class-operation.md"
?? "backlog/tasks/task-15 - Document-nanoclaw-state-discovery-what-shifts-what-doesnt.md"
?? "backlog/tasks/task-7 - Move-Aurora-morning-report-schedule-off-the-Discord-session.md"
?? "backlog/tasks/task-8 - Kill-Auroras-Discord-wiring-and-retire-the-skylight-sessions.md"
?? "backlog/tasks/task-9 - Purge-memory-and-coder-references-from-the-surviving-agents.md"
?? docs/state-discovery.md
```

### Other artifacts

- `docs/state-discovery.md` — new. Volatile state as query recipes, stable structure as recorded data (the ten `agent_group_id` tables, FK block/cascade/dangle behavior, 12-step teardown order, where per-group state lives, the scheduling/wiring independence).
- `CLAUDE.md` — added the state-discovery row to the docs index.
- Backlog tasks TASK-7 … TASK-15 and the loose-end tasks that followed.
- Memory updated: corrected the stale "not yet wired to a channel" line in the Aurora index entry; added the Discord-session schedule finding to `project_aurora_agent.md`; recorded the local/coder revisit intent and the "when in doubt, file a backlog item" working preference.

### Reference data captured this session

Useful identifiers, recorded so they don't need re-querying while the decommission work runs. **Volatile — re-verify before acting.**

| Group | Id | Folder | Fate |
|---|---|---|---|
| Aurora | `ag-1782273071167-th1q6f` | `skylight-morning` | Keep; drop Discord only |
| Mjollnir | `ag-1779381936325-6ki38t` | `dm-with-hammer` | Keep |
| Radar | `740a6fb3-5aff-42e8-b5dd-0a8a57d6b4a5` | `ai-news` | Keep |
| Memory | `f09aa5a1-bea7-410a-a319-f20da1549703` | `memory` | Delete, wiki included |
| Coder | `54c8dbdf-7703-4567-801c-da5a830cb7fd` | `coder` | Delete |
| local-qwen3.6 | `103c34dd-8610-4bd6-9fa0-b9b98f79941d` | `local-qwen3.6` | Delete |
| Terminal Agent | `ag-1779227551242-zf47au` | `_ping-test` | Delete |

Aurora's wirings — remove `f75dc4b4-b9ef-4d60-b9f8-af1abcea85f2` (discord `2f7de85e-e40d-4dbb-8ef2-c64639b94384` #skylight); keep `35671fb9-b06c-4e77-a6b3-5d3d3e7bba34` (matrix hammer DM, `mg-1783608739461-4om0w9`) and `95b041ba-7a62-4d03-82a6-c961bb1f76af` (matrix Ann DM, `f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394`).

Aurora's Discord-attached sessions: `sess-1782319186963-b2yjgn` (channel level, holds the schedule), `sess-1782785033830-whzaig`, `sess-1783527491016-ah2yj4`. Matrix session that survives: `sess-1783609624398-smn6q9`.

OneCLI vault agents to remove: Memory `48d0d710-48a6-424c-8cbf-c42d98ff0bdd`, Coder `c982a432-fbc5-4b76-83f2-f0f9262e9828`, Terminal Agent `58026a01-33b1-4485-a804-f897fa6e6d61`. local-qwen3.6 never got one.

Docker image tags present: `nanoclaw-agent-v2-b3501fc6:` `latest`, `ag-1779381936325-6ki38t`, `ag-1782273071167-th1q6f`, `740a6fb3-…` — i.e. none of the four doomed groups has an image to clean up.

## Rejections, negations & lessons learned

- **Deferred by the user: the opencode provider install stays.** TASK-11 originally left "remove opencode?" as an open decision since Coder was its only consumer. Hammer will revisit the local-model and coding-agent ideas in a different form, so the provider is kept deliberately, not by accident. Lesson: a dependency being currently unused is not evidence it should be removed — ask about intent before proposing deletion.
- **Corrected: discovery cost went unremarked.** ~36 commands went into building the picture and nothing captured it; Hammer flagged that and asked for the volatile-vs-stable split. Lesson: when an investigation is expensive, the investigation itself is a deliverable, not just its conclusion.
- **Working preference stated: when in doubt, file a backlog item.** Loose ends noted in prose (orphan OneCLI agents, orphan messaging groups, stale approval rows) should be tasks, not observations. Backlog items are cheap; unwritten loose ends are not.
- **Two `scripts/q.ts` traps cost real time.** Duplicate column names in a join silently collapse — the first `ncl` wiring query returned messaging-group names where agent-group names were expected, with no warning. And column names must be read from `sqlite_master`, not guessed: `folder` not `folder_name`, `process_after` not `due_at`, and `container_configs` has no `config` column. Both are now written down in `docs/state-discovery.md`.
- **Nearly missed the inbound-reference class entirely.** Reading `scripts/delete-cli-agent.ts` and seeing a dynamic all-tables sweep was almost taken as "deletion is handled". It only sweeps rows where `agent_group_id` = the deleted group, which is the outbound direction. Lesson: a sweep keyed on one column is only half a graph — check the reverse direction explicitly.
- **Noted, not acted on: plaintext credentials.** The scheduled morning-brief prompt embeds the Skylight account email and password directly in `messages_in.content`. Out of scope for a decommission plan; filed as its own task rather than fixed inline.
