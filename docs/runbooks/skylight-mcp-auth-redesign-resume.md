# Runbook: Resume Skylight MCP Auth Redesign

**Approved plan:** `/home/hammer/.claude/plans/glittery-sprouting-sketch.md`
**Repos:** `/home/hammer/git/Skylight` (server code), `/home/hammer/git/nanoclaw-v2` (container wiring)
**Aurora agent group:** `ag-1782273071167-th1q6f`
**Service name:** `nanoclaw-v2-b3501fc6`

---

## What this task is

Replacing the messy multi-path Skylight MCP credential system with one clean model:

- **Credentials** (email + password) arrive only via env vars on the MCP server config
- **Token** is never a static env var — lives only in a cache file
- **`authenticate` tool** captures a fresh token (via headless Chromium) and caches it
- **On 401**, the agent (Aurora) or user calls `authenticate`, then retries
- Must work in both consumers: Claude Code (`~/.claude.json`) and the NanoClaw container

---

## Current (broken) state to understand

- `SKYLIGHT_TOKEN` is baked as a static env var in the Aurora container config — this wins over any cached token.env, so re-auth via `authenticate` never sticks across sessions.
- The `authenticate` tool reads credentials from `~/.config/skylight/credentials.env` (a file), not env vars.
- `~/.config/skylight` is mounted writable into the container via a symlink hack — the whole point of this work is to eliminate all of this.

---

## Work left to do (plan approved, no code written yet)

### Part A — Skylight server code (`/home/hammer/git/Skylight`)

**File: `server/tools/__init__.py`** (~line 757)

Replace `read_credentials_file()` with env-var credential lookup:
```python
# Old:
creds = read_credentials_file()
if creds is None:
    raise ToolError("Credentials not found. Create ~/.config/skylight/credentials.env ...")
email, password = creds

# New:
email = os.environ.get("SKYLIGHT_EMAIL", "").strip()
password = os.environ.get("SKYLIGHT_PASSWORD", "").strip()
if not email or not password:
    raise ToolError(
        "Credentials not found. Set SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD "
        "as env vars on the MCP server configuration."
    )
```

Also change the `write_env_file` call (~line 777) to use a configurable path:
```python
# Old:
token_env_path = os.path.expanduser(DEFAULT_TOKEN_ENV_PATH)
# New:
token_env_path = os.path.expanduser(
    os.environ.get("SKYLIGHT_TOKEN_ENV_PATH", DEFAULT_TOKEN_ENV_PATH)
)
```

Drop the `read_credentials_file` import from line 50; keep `write_env_file`.

Check whether to delete `read_credentials_file` + `CREDENTIALS_ENV_PATH` from
`server/token_capture.py` — tests in `test_token_capture_snippet.py` cover them, and
`tools/capture_token_cli.py` also calls `read_credentials_file`. Remove those tests and
that CLI call too, or leave the function in token_capture.py and just stop importing it
from tools (low priority).

**File: `server/config.py`** (~line 176)

Make `load_settings` respect `SKYLIGHT_TOKEN_ENV_PATH`:
```python
# In the `token_env_path is _UNSET` branch, env is None means production:
if token_env_path is _UNSET:
    file_path: Path | None = (
        Path(os.environ.get("SKYLIGHT_TOKEN_ENV_PATH", DEFAULT_TOKEN_ENV_PATH)).expanduser()
        if env is None
        else None
    )
```
(Leave the `env={...}` test-isolation branch unchanged.)

**Tests** (`server/tests/test_tools.py`):
- Lines 681-731: two authenticate tests monkeypatch `read_credentials_file`. Rewrite these to instead set `SKYLIGHT_EMAIL`/`SKYLIGHT_PASSWORD` in env, and test the "missing env" error path.
- Add a test: `SKYLIGHT_TOKEN_ENV_PATH` redirects both the config read and the `authenticate` write.

Run: `cd /home/hammer/git/Skylight && uv run pytest`

---

### Part B — Claude Code consumer

Add skylight entry to `~/.claude.json` (user-scoped, never committed):
```json
{
  "mcpServers": {
    "skylight": {
      "command": "uv",
      "args": ["run", "python", "-m", "server"],
      "cwd": "/home/hammer/git/Skylight",
      "env": {
        "SKYLIGHT_EMAIL": "hamerfamily16@gmail.com",
        "SKYLIGHT_PASSWORD": "<from ~/.config/skylight/credentials.env>",
        "SKYLIGHT_FRAME_ID": "3964300"
      }
    }
  }
}
```

Get the password: `grep SKYLIGHT_PASSWORD ~/.config/skylight/credentials.env`

No `SKYLIGHT_TOKEN` and no `SKYLIGHT_AUTH_SCHEME` — token + scheme come from the cached
`~/.config/skylight/token.env`.

The bare entry in `Skylight/.mcp.json` (no env, no secrets) can remain as-is or be
removed. If both are present, Claude Code merges them (user config wins on conflict).

---

### Part C — NanoClaw container

**Step 1: Bump wheel version**

In `/home/hammer/git/Skylight/pyproject.toml`, change `version = "0.2.0"` → `"0.2.1"`.

Build:
```bash
cd /home/hammer/git/Skylight
uv build
# Produces dist/skylight-0.2.1-py3-none-any.whl
```

**Step 2: Update `scripts/setup-aurora-agent.ts`**

`readSkylightEnv()` currently reads TOKEN from token.env and bakes it in as a static env var.
Rewrite it to read EMAIL+PASSWORD from credentials.env and FRAME_ID from config.env only:

```typescript
function readSkylightEnv(): { email: string; password: string; frameId: string } {
  const configPath = path.join(os.homedir(), '.config', 'skylight', 'config.env');
  const credsPath = path.join(os.homedir(), '.config', 'skylight', 'credentials.env');
  
  let email = '';
  let password = '';
  let frameId = '';
  
  function parseEnvFile(filePath: string) {
    try {
      for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        const m = line.match(/^export\s+(\w+)=(.*)$/);
        if (!m) continue;
        const val = m[2].replace(/^['"]|['"]$/g, '').trim();
        if (m[1] === 'SKYLIGHT_EMAIL') email = val;
        if (m[1] === 'SKYLIGHT_PASSWORD') password = val;
        if (m[1] === 'SKYLIGHT_FRAME_ID') frameId = val;
      }
    } catch { /* ignore missing */ }
  }
  
  parseEnvFile(configPath);
  parseEnvFile(credsPath);
  
  if (!email || !password)
    throw new Error('SKYLIGHT_EMAIL/SKYLIGHT_PASSWORD not found in ~/.config/skylight/credentials.env');
  if (!frameId)
    throw new Error('SKYLIGHT_FRAME_ID not found in ~/.config/skylight/config.env');
  
  return { email, password, frameId };
}
```

Change the MCP config block:
```typescript
const { email, password, frameId } = readSkylightEnv();

updateContainerConfigJson(ag.id, 'additional_mounts', [
  {
    hostPath: SKYLIGHT_REPO,
    containerPath: 'skylight',   // → /workspace/extra/skylight (ro)
    readonly: true,
  },
  // skylight-config mount REMOVED
]);

updateContainerConfigJson(ag.id, 'mcp_servers', {
  skylight: {
    command: 'bash',
    args: [
      '-lc',
      [
        '[ -d /workspace/.skylight-venv-0.2.1 ] ||',
        '  (python3 -m venv /workspace/.skylight-venv-0.2.1 &&',
        '   /workspace/.skylight-venv-0.2.1/bin/pip install -q',
        '   /workspace/extra/skylight/dist/skylight-0.2.1-py3-none-any.whl);',
        'mkdir -p /workspace/.skylight;',
        'cd /workspace/extra/skylight &&',
        'exec /workspace/.skylight-venv-0.2.1/bin/python -m server',
      ].join(' '),
    ],
    env: {
      SKYLIGHT_EMAIL: email,
      SKYLIGHT_PASSWORD: password,
      SKYLIGHT_FRAME_ID: frameId,
      SKYLIGHT_TOKEN_ENV_PATH: '/workspace/.skylight/token.env',
    },
  },
});
```

Run the script to push the new config to the DB:
```bash
cd /home/hammer/git/nanoclaw-v2
pnpm exec tsx scripts/setup-aurora-agent.ts
```

**Step 3: Remove `~/.config/skylight` from the mount allowlist**

```bash
cd /home/hammer/git/nanoclaw-v2
# Use the manage-mounts skill / setup mounts step
# Or edit ~/.config/nanoclaw/mount-allowlist.json directly to remove the entry with
# "path": "/home/hammer/.config/skylight"
```

**Step 4: Restart Aurora**
```bash
ncl groups restart --id ag-1782273071167-th1q6f
# No --rebuild needed
```

---

### Part D — Instructions cleanup

In `groups/skylight-morning/CLAUDE.local.md`, update "## 401 Error Handling" (~line 96):

Old: "tell Hammer to run `uv run python tools/capture_token_cli.py ...`"
New: "call the `authenticate` tool, then retry the failed call"

---

## Verification after all parts done

1. **Tests pass:** `cd /home/hammer/git/Skylight && uv run pytest`
2. **Claude Code:** `SKYLIGHT_EMAIL`/`SKYLIGHT_PASSWORD` in `~/.claude.json`; no `token.env`
   present → tool call gets 401 guidance → `authenticate` works → subsequent call succeeds
3. **Container:** `ncl groups get --id ag-1782273071167-th1q6f` confirms new MCP env has
   EMAIL/PASSWORD/FRAME_ID/TOKEN_ENV_PATH and no SKYLIGHT_TOKEN; `additional_mounts` has
   only the repo (no skylight-config); Aurora morning report self-heals on 401
4. **Grep:** no `SKYLIGHT_TOKEN` in env-var position in either repo's Skylight wiring

---

## Key facts

| Item | Value |
|------|-------|
| Aurora agent group ID | `ag-1782273071167-th1q6f` |
| Aurora group folder | `groups/skylight-morning/` |
| Service name | `nanoclaw-v2-b3501fc6` |
| Skylight credentials | `~/.config/skylight/credentials.env` (email + password) |
| Skylight config | `~/.config/skylight/config.env` (frame id) |
| Current token cache | `~/.config/skylight/token.env` |
| Skylight repo | `/home/hammer/git/Skylight` |
| Approved plan | `/home/hammer/.claude/plans/glittery-sprouting-sketch.md` |
