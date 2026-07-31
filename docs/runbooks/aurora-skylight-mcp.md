# Runbook: Aurora ↔ Skylight MCP

**Context:** Aurora (morning report assistant) reads the family calendar/chores from the
[Skylight](https://app.ourskylight.com) web app through a Python MCP server that lives in a
separate repo. This runbook is the map of that wiring — read it before debugging an
Aurora report that comes back wrong or empty.

| Thing | Where |
|-------|-------|
| Agent group | `Aurora` — `ag-1782273071167-th1q6f`, folder `groups/skylight-morning/` |
| Agent instructions | `groups/skylight-morning/CLAUDE.local.md` (`CLAUDE.md` is composed at spawn — don't edit it) |
| MCP server source | `/home/hammer/git/Skylight` (separate repo, branch `main`) |
| MCP server config | `container_configs.mcp_servers` in `data/v2.db`, key `skylight` |
| Wheel consumed by the container | `/home/hammer/git/Skylight/dist/skylight-<version>-py3-none-any.whl` |
| Skylight repo docs | `docs/auth.md`, `docs/mcp/client-setup.md` |

---

## How the MCP server actually gets into the container

There is no image layer for it. The whole thing is bootstrapped at MCP-launch time by the
`command`/`args` stored in the DB:

1. `/home/hammer/git/Skylight` is bind-mounted **read-only** at `/workspace/extra/skylight`
   (`container_configs.additional_mounts`).
2. On first launch the bootstrap line creates `/workspace/.skylight-venv-<version>/` and
   `pip install`s the wheel from that mount.
3. Subsequent launches see the venv directory already exists and skip straight to
   `exec …/bin/python -m server`.

**Consequences worth knowing:**

- **The version string appears three times in one shell line** — venv path (×2 more inside)
  and wheel filename. Bumping the wheel means bumping all of them together, which is why
  the version is baked into the venv directory name: a new version gets a fresh venv rather
  than a dirty upgrade in place.
- **The `[ -d venv ] ||` guard is not integrity-checking.** If a `pip install` fails partway,
  the directory still exists, so every later launch skips reinstall and the server imports a
  venv missing half its dependencies. Symptom: `ModuleNotFoundError` for something like
  `anyio`. Fix: `rm -rf` the venv directory and relaunch.
- **Everything is per-session.** `/workspace` is the *session* directory
  (`data/v2-sessions/<group>/<session>/`), not a group-wide one. Each session builds its own
  venv (~100 MB) and captures its own token. A new session re-does the whole bootstrap.
- **`pip` needs the OneCLI proxy CA.** `PIP_CERT=/tmp/onecli-combined-ca.pem` is in the MCP
  env; the host materializes that file at container spawn. If you spawn a container by hand
  with plain `docker run`, that path won't exist and the install dies with
  `Could not find a suitable TLS CA certificate bundle`. Either drop `PIP_CERT` and use an
  already-provisioned venv, or go through `ncl groups restart`.

## Authentication

Skylight has no API keys or OAuth. The only way to get a token is to log into the real web
app and intercept the first authenticated `/api/` request. The MCP's `authenticate` tool
does this with headless Chromium via Playwright, then writes the token to
`SKYLIGHT_TOKEN_ENV_PATH` (`/workspace/.skylight/token.env`) and injects it into the running
server process. Tokens expire and there is no refresh flow — Aurora is instructed to call
`authenticate` on any 401 and retry.

**Credentials are environment variables on the MCP server** (`SKYLIGHT_EMAIL` /
`SKYLIGHT_PASSWORD` in `container_configs.mcp_servers`), currently stored in plaintext in
`data/v2.db` and mirrored into `groups/skylight-morning/container.json` at spawn. The
`~/.config/skylight/credentials.env` path in the tool's docstring is the *standalone CLI*
fallback and is **not** how Aurora is wired. This trips up the agent — see below.

### The Playwright-Python / system-Chromium gap

The base image (`container/Dockerfile:61-65`) deliberately ships a system Chromium and skips
Playwright's ~170 MB managed browser download:

```
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is a **Playwright JS** convention. `agent-browser` and
the other JS tools in the image honour it. **Playwright Python ignores it entirely** — it
looks only for its own managed download and fails with:

```
BrowserType.launch: Executable doesn't exist at
/home/node/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
```

So the image looks correctly configured — the env var is set, `/usr/bin/chromium` exists, JS
browser tooling in the same container works — while the one Python consumer silently can't
launch a browser at all.

**Fix (applied 2026-07-29, Skylight 0.2.2):** `server/token_capture.py` reads that env var
itself and passes it to `pw.chromium.launch(executable_path=…)`. Unset/empty falls back to
Playwright's managed download, so the maintainer's interactive capture flow is unchanged.
`capture_token` now also wraps launch failures in a `CaptureError` that says explicitly that
this is a browser-provisioning problem, not a credentials problem.

Do **not** "fix" this by baking a Playwright browser bundle into Aurora's image:
`buildAgentGroupImage` (`src/container-runner.ts:496-508`) generates its Dockerfile from
*only* the apt/npm package lists, so a hand-built image is silently clobbered by the next
`ncl groups restart --rebuild`.

## Failure modes, and why they're hard to read

The reason this took a session to diagnose is that **three separate layers each degrade
quietly**, and the visible symptom is furthest from the cause:

| Layer | What goes wrong | What you see |
|-------|-----------------|--------------|
| Container | Playwright can't find a browser | nothing — it's inside the MCP subprocess |
| MCP server | `authenticate` throws → no `SKYLIGHT_TOKEN` → every read tool fails | nothing — the agent gets a tool error |
| Agent | renders the failure using the template's *empty-state* line | "No chores due today. Nothing on the calendar tomorrow." |

A blank-but-cheerful morning report is the failure mode to watch for. It is indistinguishable
from a genuinely free day unless you check.

`CLAUDE.local.md` now has two guards against the agent-side half:

- **"Never Report a Failure as an Empty Result"** — the empty-state lines mean *the call
  succeeded and returned nothing*. If you can't point to a successful response, say the
  section is unavailable and quote the error.
- **"When `authenticate` Fails — Report, Don't Diagnose"** — quote the error verbatim; never
  claim credentials are missing, and never ask Hammer for his Skylight password. (Aurora did
  exactly this on 2026-07-29: she read the `~/.config/skylight/credentials.env` path out of
  the tool's own docstring and reported it as the root cause. It was not.)

## Bumping the Skylight wheel

```bash
cd /home/hammer/git/Skylight
# 1. edit source
sed -i 's/^version = "0.2.2"/version = "0.2.3"/' pyproject.toml
make lint && make test-server        # test-tools has 5 pre-existing failures
make build                           # -> dist/skylight-0.2.3-py3-none-any.whl
```

Then point Aurora at it. The password lives in the JSON you're editing, so mutate it in
place rather than retyping the whole object:

```bash
cd /home/hammer/git/nanoclaw-v2
# read mcp_servers, string-replace the old version with the new across args[], write back
# via updateContainerConfigJson(group, 'mcp_servers', …) — see src/db/container-configs.ts
ncl groups restart --id ag-1782273071167-th1q6f --message "Verify the Skylight MCP works: call authenticate, then list today's chores."
```

No `--rebuild` needed — the wheel is installed at MCP launch, not baked into the image.

## Verifying auth without touching the live agent

```bash
docker run --rm \
  --env-file <file with SKYLIGHT_EMAIL/PASSWORD, no PIP_CERT> \
  -v <session-dir>:/workspace \
  -v /home/hammer/git/Skylight:/workspace/extra/skylight:ro \
  -e PYTHONPATH=/workspace/extra/skylight \
  --entrypoint bash <image-tag> -lc \
  '/workspace/.skylight-venv-0.2.2/bin/python -c "
import asyncio, os
from server import auth
r = asyncio.run(auth.authenticate(email=os.environ[\"SKYLIGHT_EMAIL\"],
                                  password=os.environ[\"SKYLIGHT_PASSWORD\"], timeout=30))
print(\"OK\", r.scheme, r.frame_id)"'
```

Setting `PYTHONPATH` to the mount runs the repo source directly against an
already-provisioned venv — this tests a source change without needing a wheel build, a
network round-trip, or the proxy CA.

## Known rough edges (not fixed)

- **Credentials are plaintext** in `data/v2.db` and in
  `groups/skylight-morning/container.json`. Deliberate for now. Moving them to a mounted
  `credentials.env` would need `additional_mounts` to target a path outside
  `/workspace/extra/`; moving them into OneCLI doesn't obviously fit, since the login is a
  browser form rather than an HTTP call the proxy can intercept.
- **Per-session venvs and tokens.** Every new Aurora session re-installs ~100 MB of wheels
  and re-authenticates from scratch. A group-level shared mount would fix both.
- **Old venvs are never garbage-collected.** `data/v2-sessions/<group>/<session>/` accumulates
  a `.skylight-venv-<version>` per version ever used. Clean up by hand after a bump.
