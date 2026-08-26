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
| Bootstrap command (source of truth) | `scripts/skylight-mcp-bootstrap.sh` — the DB column is a materialized copy |
| Wheel consumed by the container | `/home/hammer/git/Skylight/dist/skylight-<version>-py3-none-any.whl` |
| Skylight repo docs | `docs/auth.md`, `docs/mcp/client-setup.md` |

---

## How the MCP server actually gets into the container

There is no image layer for it. The whole thing is bootstrapped at MCP-launch time by the
`command`/`args` stored in the DB:

1. `/home/hammer/git/Skylight` is bind-mounted **read-only** at `/workspace/extra/skylight`
   (`container_configs.additional_mounts`).
2. On first launch the bootstrap line deletes any stale sentinel, removes any stale
   `/workspace/.skylight-venv-<version>/`, recreates it, `pip install`s the wheel from that
   mount, verifies the result with `python -c "import server.app"`, and only then writes the
   sentinel file `/workspace/.skylight-venv-<version>/.provisioned`.
3. Subsequent launches see the **sentinel** and skip straight to
   `exec …/bin/python -m server`.

The whole thing is one `bash -lc` string. `command` is `bash` and `args` is
`["-lc", "<the line>"]`.

**The line is not written by hand and is not quoted here.** Its single source of truth is

> **[`scripts/skylight-mcp-bootstrap.sh`](../../scripts/skylight-mcp-bootstrap.sh)**

— a readable, commented, version-controlled shell script. `scripts/skylight-mcp-bootstrap.ts`
strips its comments and collapses it to one line; `scripts/setup-aurora-agent.ts` stores that
line in the DB column. To see exactly what is running, read that file — or print the collapsed
form the seeder would write:

```bash
cd /home/hammer/git/nanoclaw-v2
pnpm exec tsx -e "import('./scripts/skylight-mcp-bootstrap.js').then(m => console.log(m.skylightBootstrapLine()))"
```

`scripts/skylight-mcp-bootstrap.test.ts` (run by `pnpm test`) fails if the stored column and
the script disagree, so the DB can no longer drift silently. To change the bootstrap: edit the
`.sh`, re-run the seeder, restart the group.

The Skylight credentials are *not* in that line — they are separate keys (`SKYLIGHT_EMAIL`,
`SKYLIGHT_PASSWORD`, `SKYLIGHT_FRAME_ID`) on the sibling `env` object, which is deliberately
not reproduced here or in the script. Never paste those values into a doc, a commit message,
or a chat.

**Consequences worth knowing:**

- **The version appears once, as `VER=` at the head of the line.** The venv path and the
  wheel filename are both derived from it. The version is still baked into the venv
  directory name, so a new version gets a fresh venv rather than a dirty upgrade in place.
- **The guard is the sentinel, not the directory.** `[ ! -f "$V/.provisioned" ]` is what
  decides whether to (re)provision, and the sentinel is written only after `pip` exits 0
  *and* the import probe succeeds. A venv that exists but has no sentinel is treated as
  absent and rebuilt from scratch — so an interrupted or failed install can no longer
  poison every later launch. (Before 2026-08-20 the guard was `[ -d "$V" ]`, which
  `python3 -m venv` satisfies *before* pip runs; that bug bit Aurora three times. See
  "Recovering from a half-built venv" below.)
- **The probe is `import server.app`, not `import server`.** `server/__init__.py` imports
  nothing at module level — a docstring, `__all__`, and a lazy `__getattr__` — so
  `import server` succeeds on a venv holding the wheel and *none* of its ~70 dependencies.
  `server/app.py` is where `from fastmcp import FastMCP` lives, so importing it exercises
  the dependency closure. Verified on a deliberately dependency-less venv (9 site-packages
  entries): `import server` passes, `import server.app` fails with
  `ModuleNotFoundError: No module named 'fastmcp'`.
- **The probe runs from the server's real cwd.** It is
  `( cd /workspace/extra/skylight && "$V/bin/python" -c "import server.app" )`, matching the
  `cd /workspace/extra/skylight; exec "$V/bin/python" -m server` at the end of the line. This
  matters more than it looks: with `-m`, the cwd precedes site-packages on `sys.path`, so the
  code that actually runs is the **read-only source mount**, not the wheel copy in the venv.
  The venv effectively supplies only the dependencies. Probing from the same cwd checks the
  thing that will execute. (Before 2026-08-20 the probe ran with `cd /`, which validated the
  wheel copy instead.)
- **The stale sentinel is deleted before the `rm -rf`, not after.** Two launches can both
  observe "no sentinel" and race. If the second one's `rm -rf` is interrupted partway through
  a tree the first has already finished and sentinelled, the survivor would be a gutted venv
  that looks provisioned forever — the exact sticky-poison failure the sentinel exists to
  prevent. Removing the token first means any interruption leaves an *unsentinelled* venv,
  which is always rebuilt.
- **Provisioning failure is fatal and loud.** On any failure the line writes
  `skylight-mcp: PROVISIONING FAILED (…)` to stderr naming the venv and wheel paths, then
  exits non-zero. It deliberately does **not** fall through to `exec … -m server`, because
  that is what used to turn a provisioning failure into a misleading `ModuleNotFoundError`.
- **Failures *after* the sentinel is written use `die`, not `fail`.** `mkdir -p
  /workspace/.skylight` and the final `cd` run once provisioning has already succeeded, so
  the venv is known-good and the realistic cause is a missing mount, not a bad install. They
  print `skylight-mcp: STARTUP FAILED (…)` and explicitly tell you *not* to delete the venv —
  the `fail` message's `rm -rf $V` advice would destroy ~100 MB of healthy venv to fix an
  `additional_mounts` misconfiguration.
- **All provisioning chatter goes to stderr.** `pip` no longer runs with `-q` (its errors
  need to reach the container log), so every provisioning command is redirected `>&2`.
  This process's stdout is the MCP stdio JSON-RPC channel — anything printed there
  corrupts the protocol.
- **Everything is per-session.** `/workspace` is the *session* directory
  (`data/v2-sessions/<group>/<session>/`), not a group-wide one. Each session builds its own
  venv (~100 MB) and captures its own token. A new session re-does the whole bootstrap.
- **`pip` needs the OneCLI proxy CA.** `PIP_CERT=/tmp/onecli-combined-ca.pem` is in the MCP
  env; the host materializes that file at container spawn. If you spawn a container by hand
  with plain `docker run`, that path won't exist and the install dies with
  `Could not find a suitable TLS CA certificate bundle`. Either drop `PIP_CERT` and use an
  already-provisioned venv, or go through `ncl groups restart`.

### Recovering from a half-built venv

**What it looks like now.** A failed install stops the MCP server dead. The container log
carries pip's real error followed by:

```
skylight-mcp: PROVISIONING FAILED (pip install failed). venv=/workspace/.skylight-venv-0.2.3
wheel=/workspace/extra/skylight/dist/skylight-0.2.3-py3-none-any.whl. Refusing to start the
server -- launching it now would surface as a misleading ModuleNotFoundError. …
```

The parenthesised reason is one of six, in the order they can occur:

| Reason | Meaning |
|--------|---------|
| `could not invalidate stale sentinel` | `rm -f "$V/.provisioned"` failed — venv dir not writable |
| `could not remove stale venv` | `rm -rf "$V"` failed — usually a read-only or busy mount |
| `python3 -m venv failed` | no usable `python3`, or no space |
| `pip install failed` | the common one — missing wheel, no `PIP_CERT`, network/proxy |
| `post-install import check failed - venv is missing dependencies` | pip claimed success but the dependency closure is incomplete |
| `could not write sentinel` | `/workspace` not writable |

The import-check reason is the old `ModuleNotFoundError: No module named 'anyio'` symptom,
caught at provisioning time and correctly labelled. Aurora sees the MCP server fail to
start, not a working server with broken tools.

Two further reasons appear under `STARTUP FAILED` rather than `PROVISIONING FAILED`, and
mean the venv is fine but the container isn't: `mkdir /workspace/.skylight failed` and
`cd /workspace/extra/skylight failed`. Check `container_configs.additional_mounts`; do not
delete the venv.

**How to spot a half-built venv on disk.** Count the entries in `site-packages`. A healthy
Skylight venv has ~160. A half-built one has anywhere from ~9 (just pip, setuptools and the
`server` package itself, if pip landed the wheel but none of its dependencies) up to a few
dozen (if pip died partway through the dependency list — e.g. the real 0.2.1 casualty still
on disk has 16, including `playwright` and `greenlet`). The signature is not a specific
number: it is the *absence* of the big names — `fastmcp`, `mcp`, `pydantic`, `httpx`,
`anyio`. Check for those rather than counting.

```bash
cd data/v2-sessions/ag-1782273071167-th1q6f
for d in */; do for v in "$d".skylight-venv-*; do [ -d "$v" ] || continue; \
  echo "$v -> $(ls "$v"/lib/python*/site-packages | wc -l) pkgs, sentinel=$([ -f "$v/.provisioned" ] && echo yes || echo no)"; \
done; done
```

Anything without a sentinel will be rebuilt on next launch regardless of what's inside it,
so the count is a diagnostic, not a decision. A venv *with* a sentinel is trusted blindly —
the only way one of those can be broken is if somebody hand-placed the sentinel (see
"Marking a venv you have verified by hand"), so re-run the probe there before believing it.

**Forcing a rebuild.** Delete the sentinel (or the whole directory) and relaunch:

```bash
rm -rf data/v2-sessions/<group>/<session>/.skylight-venv-<version>
ncl groups restart --id ag-1782273071167-th1q6f --message "Verify the Skylight MCP works: call authenticate, then list today's chores."
```

The rebuild happens inside the properly-provisioned container, which is the only place
`PIP_CERT=/tmp/onecli-combined-ca.pem` exists — never try to repair a venv with a bare
`docker run`, which is what created the broken ones in the first place.

**Marking a venv you have verified by hand.** If you are confident an existing venv is
complete and want to skip a ~100 MB reinstall, run the same check the bootstrap runs and
touch the sentinel only if it passes:

```bash
docker run --rm --network none \
  -v "$PWD/data/v2-sessions/<group>/<session>":/workspace:ro \
  -v /home/hammer/git/Skylight:/workspace/extra/skylight:ro \
  --entrypoint bash <image-tag> \
  -lc 'cd /workspace/extra/skylight && /workspace/.skylight-venv-<version>/bin/python -c "import server.app"'
# only if that exits 0:
: > data/v2-sessions/<group>/<session>/.skylight-venv-<version>/.provisioned
```

Both halves matter. `import server.app` rather than `import server`, because
`server/__init__.py` imports nothing at module level and so passes on a venv with no
dependencies at all. And `cd /workspace/extra/skylight` rather than `cd /`, because that is
the cwd the server runs from — `-m server` puts it ahead of site-packages on `sys.path`, so
this checks the source-mount code path that will actually execute, against the venv's
dependencies.

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

Then point Aurora at it. Bump `VER=` in the canonical script and re-run the seeder — it
re-reads the credentials from `~/.config/skylight/`, so you never handle the password:

```bash
cd /home/hammer/git/nanoclaw-v2
sed -i 's/^VER=0.2.2;$/VER=0.2.3;/' scripts/skylight-mcp-bootstrap.sh
pnpm test scripts/skylight-mcp-bootstrap.test.ts   # red until the seeder runs — that is the point
pnpm exec tsx scripts/setup-aurora-agent.ts        # rewrites mcp_servers from the script
pnpm test scripts/skylight-mcp-bootstrap.test.ts   # green: DB and script agree again
ncl groups restart --id ag-1782273071167-th1q6f --message "Verify the Skylight MCP works: call authenticate, then list today's chores."
```

The seeder overwrites the whole `mcp_servers` object, not just `args[1]` — if you have
hand-tuned anything else on that row (an extra `env` key, say), mirror it into the seeder
first or it is lost. See TASK-27.

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
network round-trip, or the proxy CA. `PYTHONPATH` is genuinely needed *here* because this
command never `cd`s: the image's `WORKDIR` is `/workspace/group`, so without it `from server
import auth` would resolve to the wheel copy inside the venv. The live server doesn't need
it, because it `cd`s to the mount first and `-m` puts the cwd on `sys.path` for free.

Note this invokes the venv's python *directly*. Do not run the DB's bootstrap line by hand
against a live session directory: without `PIP_CERT` the install fails, and the first thing
the line does is `rm -rf` the venv — you would destroy a working install to reproduce a
broken one.

## Known rough edges (not fixed)

- **Credentials are plaintext** in `data/v2.db` and in
  `groups/skylight-morning/container.json`. Deliberate for now. Moving them to a mounted
  `credentials.env` would need `additional_mounts` to target a path outside
  `/workspace/extra/`; moving them into OneCLI doesn't obviously fit, since the login is a
  browser form rather than an HTTP call the proxy can intercept.
- **Per-session venvs and tokens.** Every new Aurora session re-installs ~100 MB of wheels
  and re-authenticates from scratch. A group-level shared mount would fix both.
- **Old venvs are never garbage-collected.** `data/v2-sessions/<group>/<session>/` accumulates
  a `.skylight-venv-<version>` per version ever used. Clean up by hand after a bump — the
  bootstrap only ever touches the directory for the version it is currently pinned to, so
  older ones sit there untouched (and without sentinels) forever.
- **The bootstrap line still has to be *copied* into a DB column.** `container_configs
  .mcp_servers` is what actually runs, and the container cannot read this repo, so the line is
  materialized into `data/v2.db` rather than referenced from it. Since TASK-26 that copy has a
  single version-controlled source (`scripts/skylight-mcp-bootstrap.sh`) and a test that fails
  on divergence, but nothing *re-*materializes it: after editing the `.sh` you must re-run
  `pnpm exec tsx scripts/setup-aurora-agent.ts` and restart the group, or the test will (loudly)
  stay red. Note the seeder overwrites `mcp_servers` unconditionally — it is safe to re-run, not
  a no-op.
