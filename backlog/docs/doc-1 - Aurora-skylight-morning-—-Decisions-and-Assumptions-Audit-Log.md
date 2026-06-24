---
id: doc-1
title: Aurora (skylight-morning) — Decisions and Assumptions Audit Log
type: guide
created_date: '2026-06-24 04:18'
updated_date: '2026-06-24 04:19'
---
# Aurora (skylight-morning) — Decisions and Assumptions Audit Log

**Build mode:** Headless operation — no user input was solicited during construction. Every question that would normally go to the user was resolved by research and logged here. This document satisfies the audit requirement from the user specification.

**Agent group ID:** ag-1782273071167-th1q6f  
**Group folder:** groups/skylight-morning/  
**Build date:** 2026-06-23

---

## Decision 1 — Agent Name: Aurora

**Decision:** Name the assistant "Aurora."

**Rationale:** Aurora is the Roman goddess of dawn — semantically fitting for a morning report assistant. The name is evocative, memorable, and directly encodes the assistant's purpose.

**Alternatives considered:**
- Hermes (Greek messenger god) — thematically adjacent but implies general message-passing, not a morning context.
- Generic "Morning" — too literal, no personality.

**Research basis:** No user input; name chosen by convention matching the morning-report purpose.

---

## Decision 2 — Group Folder Name: skylight-morning

**Decision:** Use `skylight-morning` as the group folder (not `aurora`).

**Rationale:** NanoClaw convention separates the agent's display name (Aurora) from its filesystem identity (the group folder). The folder name is descriptive and encodes both the Skylight MCP integration and the morning-report purpose, making it self-documenting for operators.

**Research basis:** Reviewed existing groups/ layout; nanoclaw pattern is folder ≠ display name.

---

## Decision 3 — Model: Default (claude-sonnet-4-6)

**Decision:** No model override; use the default agent model.

**Rationale:** Morning reports are read-heavy, low-compute tasks. They require tool calls and formatting, not extended reasoning. The default Sonnet model is sufficient. Overriding to a more powerful model would increase cost without benefit.

**Research basis:** Task profile assessment; no user preference expressed.

---

## Decision 4 — cli_scope: group (default)

**Decision:** Leave `cli_scope` at the default (`group`).

**Rationale:** Aurora has no administrative purpose — it reads Skylight data and formats reports. It has no reason to access other agent groups, global session lists, or cross-group resources. Group scope is the correct and least-privileged default.

**Research basis:** CLAUDE.md cli_scope table; no deviation warranted.

---

## Decision 5 — MCP Credential Approach: env vars in McpServerConfig, not mounted files

**Decision:** Store the Skylight API token directly in `McpServerConfig.env` (written to `data/v2.db` and materialized to `groups/skylight-morning/container.json` at spawn time). Do not mount credential files into the container.

**Rationale:**
- Original plan was `bash -lc` sourcing of `~/.config/skylight/token.env` at container startup.
- **Research finding 1:** The container runs as user `node` with `HOME=/home/node`, not `/home/hammer`. Shell profile sourcing of host-user dotfiles does not work.
- **Research finding 2:** Mount-security module rejects absolute `containerPath` values; relative paths resolve under `/workspace/extra/`, not the home directory.
- **Research finding 3:** `token.env` matches the blocked filename pattern (`.env`-suffix files are blocked from mounts by the mount-security allowlist logic).
- **Research finding 4:** Mounting raw credential files bypasses the OneCLI gateway pattern that the architecture is designed around.

**Final approach:** Token read at setup-script runtime from `~/.config/skylight/token.env`; stored in `McpServerConfig.env`. For a personal install, storing the token in the central DB is acceptable — it is equivalent to the `.env` file already in use for other secrets.

**Assumption logged:** The token in `~/.config/skylight/token.env` is long-lived (not ephemeral OAuth). If it rotates, the operator must re-run the setup script or update the McpServerConfig manually.

---

## Decision 6 — MCP Server Invocation: bash -lc pattern

**Decision:** Invoke the Skylight MCP server via `bash -lc 'source ... && python3 ...'` rather than a plain `python3` command with an `env` block.

**Rationale:** The MCP server is a Python process that needs the venv activated and env vars set before it starts. The `bash -lc` pattern handles both in one command string without requiring a wrapper script file. The `env` block in McpServerConfig applies to the MCP process directly, making the `bash -lc` pattern work cleanly when combined with the venv activation.

**Research basis:** Reviewed McpServerConfig schema; confirmed `command`/`args`/`env` structure. The `env` block is the correct place for credentials; activation is handled in the shell invocation.

---

## Decision 7 — Python Runtime: packages_apt + venv from mounted wheel

**Decision:** Install Python (`python3`, `python3-pip`, `python3-venv`) via `packages_apt`. Create a venv at `/workspace/.skylight-env` from the Skylight wheel (`dist/skylight-0.2.0-py3-none-any.whl`) located in the mounted repo.

**Rationale:**
- The container base image (`node:22-slim`) ships no Python.
- `packages_apt` is the documented mechanism for adding system packages to per-group containers.
- A local wheel install avoids an external PyPI dependency for the core package; the wheel is self-contained for pure-Python deps.
- The venv path `/workspace/.skylight-env` is inside the workspace (persistent across restarts within a session) but not inside the mounted Skylight repo (avoids polluting the source tree).

**Alternatives considered:**
- `uv` — faster installs, but not available in `node:22-slim` apt repos without additional steps.
- Global pip install — rejected; pollutes the system Python, potential conflicts.
- Pre-built venv in container image — rejected; requires rebuilding the image on every Skylight update.

**Assumption logged:** The wheel at `dist/skylight-0.2.0-py3-none-any.whl` is present in the Skylight repo at the time of container startup. If the wheel is absent (e.g., repo freshly cloned, no build step run), the MCP server will fail to start.

---

## Decision 8 — Mount Approach: relative containerPath, allowlist updated

**Decision:** Mount the Skylight repo using `containerPath: 'skylight'` (relative), resolving to `/workspace/extra/skylight`. Add `/home/hammer/git/Skylight` to `~/.config/nanoclaw/mount-allowlist.json` via the setup script (idempotent).

**Rationale:**
- Mount-security module rejects absolute `containerPath` values (e.g., `/skylight`).
- The relative path `'skylight'` resolves under `/workspace/extra/` — the documented location for extra mounts.
- The host path must appear in the allowlist before the mount is accepted; the setup script handles this idempotently.

**Research basis:** Reviewed `src/modules/security/mount-security.ts`; confirmed absolute path rejection and the `/workspace/extra/` resolution scheme.

**Assumption logged:** `/home/hammer/git/Skylight` is the stable location of the Skylight repo. If it moves, both the mount config and the allowlist entry must be updated.

---

## Decision 9 — SKYLIGHT_FRAME_ID: auto-detected from config.env

**Decision:** Read `SKYLIGHT_FRAME_ID` from `~/.config/skylight/config.env` (value: `3964300`). Pass via `McpServerConfig.env`, not via mount.

**Rationale:** The Skylight bootstrap auto-detects and writes the frame ID to `config.env` after token capture. Reading it at setup-script runtime and storing it in the McpServerConfig env is consistent with the token approach (Decision 5) and avoids an additional mount.

**Assumption logged:** `SKYLIGHT_FRAME_ID=3964300` is stable for this install. Frame IDs are workspace-level identifiers in the Skylight API and do not rotate.

---

## Decision 10 — Morning Report API Sequence: 4 calls

**Decision:** The standard morning report calls these tools in order:
1. `list_calendar_events` (date_min=today, date_max=today) — today's events
2. `list_chores` (after=yesterday, before=tomorrow, include_late=true) — today's chores including overdue items
3. `list_categories` — maps category_id (int) → label (string) for reward point display
4. `get_reward_points` — reward point balances per category

**Tools intentionally excluded:**
- `list_rewards` — returns redemption history, not balances; redundant given `get_reward_points`.
- Write tools (`create_chore`, `create_task_box_item`, `delete_chore`, `delete_task_box_item`) — included in MCP but not called during report generation.

**Research basis:** Reviewed Skylight MCP tool definitions and server/models.py. Key finding: the category label field is `attributes.label`, NOT `attributes.name` — verified against the model definition to avoid a silent field-name bug.

---

## Decision 11 — Date Windows for API Calls

**Decision:**
- Calendar: `date_min=today`, `date_max=today` (24-hour window)
- Chores: `after=yesterday`, `before=tomorrow` (48-hour window)

**Rationale:**
- The live Skylight API returns 130,000+ items without a date filter, causing timeouts (422 errors on chores).
- A 48-hour window for chores captures all-day items and overdue ("late") items that may have a due date of yesterday but are still pending.
- A strict 24-hour window for calendar events matches user expectation of "what's on my calendar today."

**Assumption logged:** The agent generates the report for the current local date. No timezone offset is explicitly injected; the container uses UTC by default. If the user's local timezone diverges significantly from UTC, "today" may not match the user's calendar day. Timezone configuration is deferred to future work.

---

## Decision 12 — Write Tools: Immediate (No Dry-Run), Agent Confirms Verbally

**Decision:** Write tools (`create_chore`, etc.) are included in the MCP config and call the live API immediately when invoked. There is no `confirm=true` dry-run parameter in the implemented server code.

**Context:** The design surface spec (`Skylight/docs/surface.md`) specified a `confirm=true` dry-run mode. The actual MCP implementation does not have this parameter.

**Mitigation:** The agent CLAUDE.md instructs Aurora to always confirm with Hammer verbally before calling any write tool. The guard is behavioral (in the system prompt), not mechanical (in the API).

**Assumption logged:** Verbal confirmation is sufficient for a personal assistant. If Aurora ever operates in a context where it might act autonomously (e.g., triggered by a cron without human in the loop), the write tool guard must be revisited.

---

## Decision 13 — Scheduling: Deferred Until Channel Attachment

**Decision:** Daily auto-trigger (e.g., 7 AM cron message) is not configured. Aurora generates a morning report when the user sends a trigger message manually.

**Rationale:** NanoClaw scheduling requires a messaging group to be wired to the agent group. Channel attachment is explicitly out of scope for this build (see Decision 14). Without a wired channel, there is no delivery target for a scheduled message.

**Future work:** Once a channel is attached, add a cron entry (e.g., `ncl groups config update --id ag-1782273071167-th1q6f` or equivalent) to send a "Good morning — please generate today's report" message at a configured time.

---

## Decision 14 — Channel Attachment: Deferred (User Requirement)

**Decision:** The agent group `ag-1782273071167-th1q6f` was created with full configuration but is NOT wired to any messaging group.

**Rationale:** The user specification explicitly stated: "ready to be attached to a channel, but not yet attached." Wiring was intentionally excluded from this build scope.

**What remains:** Run `ncl wirings create` (or use `/manage-channels`) to attach Aurora to the desired messaging group when ready.

---

## Decision 15 — Container Rebuild: Manual Operator Step

**Decision:** The setup script configures `packages_apt` (adding Python) but does NOT trigger a container rebuild. The operator must run:

```
ncl groups restart --id ag-1782273071167-th1q6f --rebuild
```

**Rationale:** A rebuild takes significant time and requires the host service to be running. Baking it into the setup script would make the script non-idempotent and could interrupt a running service during an install. Explicitly documenting it as an operator step is the correct boundary.

**Assumption logged:** The operator will run the rebuild before first use. If Aurora is triggered before the rebuild, the container will start without Python and the MCP server will fail to initialize.

---

## Assumptions Summary (All Decisions Made Without User Input)

| # | Assumption | Research Basis |
|---|-----------|----------------|
| A1 | "Aurora" is an acceptable name for the morning assistant | Name convention analysis; dawn-goddess semantics match morning report purpose |
| A2 | Token in `~/.config/skylight/token.env` is long-lived, not ephemeral | Skylight auth model; token captured once at bootstrap |
| A3 | SKYLIGHT_FRAME_ID=3964300 is stable | Read from `~/.config/skylight/config.env`; frame IDs are workspace-level identifiers |
| A4 | The Skylight wheel exists at `dist/skylight-0.2.0-py3-none-any.whl` at container start | Wheel present at setup time; operator must build if not present |
| A5 | `/home/hammer/git/Skylight` is the stable repo location | Confirmed at setup time; not expected to move |
| A6 | UTC is an acceptable timezone approximation for "today" | No timezone config present; container default is UTC |
| A7 | Verbal confirmation is sufficient guard for write tools | Personal-use context; single user; no autonomous scheduling of write operations |
| A8 | Operator will rebuild the container before first use | `packages_apt` change is documented as requiring --rebuild; cannot be automated from setup script |
| A9 | `attributes.label` (not `attributes.name`) is the correct field for category names | Verified against `server/models.py` in the Skylight repo |
| A10 | A 48-hour chore window (yesterday→tomorrow) captures all relevant items | Live API testing showed 422 without date filter; 48h window chosen to include overdue items |
