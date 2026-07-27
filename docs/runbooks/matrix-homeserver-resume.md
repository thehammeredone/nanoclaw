# Runbook: Resume Matrix Homeserver Setup

**Context:** Self-hosted Matrix homeserver for Aurora (morning report assistant) → Ann's iPhone via Element iOS.
**Plan file:** `/home/hammer/.claude/plans/glittery-sprouting-sketch.md`
**Stack location:** `~/matrix-stack/` (outside the nanoclaw repo, not in git)
**Homeserver URL:** `https://thehammeredone.ddns.net`

---

## Current state (as of 2026-07-09, final)

**Design changed mid-session:** two separate DMs (hammer↔Aurora, ann↔Aurora), not the shared group room. See "Design pivot" section below.

| Component | Status |
|-----------|--------|
| Postgres | ✅ Running and healthy |
| Synapse | ✅ Running and healthy |
| Caddy | ✅ Running — production Let's Encrypt cert issued |
| Let's Encrypt cert | ✅ Issued (production `acme-v02`, via `tls-alpn-01`) — `https://thehammeredone.ddns.net/_matrix/client/versions` returns clean `200` |
| Matrix accounts | ✅ `@hammer` (admin), `@ann`, `@aurora` registered. Passwords generated this session — not in this repo, see `matrix-credentials.local.md` (gitignored). |
| Matrix DM channels | ✅ hammer↔Aurora and ann↔Aurora both wired and end-to-end tested. See "Design pivot" below. |
| Matrix adapter in NanoClaw | ✅ Installed and connected. The earlier flaky-WSL-DNS issue (see below, kept for history) resolved on its own after a few restarts — no `/etc/hosts` pin was ultimately needed. |
| Ann's iPhone (Element) | ❌ Not yet set up — requires physical access to Ann's phone, hand-off item |
| Hammer's Android phone (Element) | ❌ Not yet set up — DM already tested via API/host, just needs the mobile client signed in, hand-off item |

### Design pivot: two DMs instead of a shared group room

The original plan (Steps 5-6 below) was a single shared "Morning Briefing" room with hammer, ann, and aurora all joined. Partway through testing, the user decided they'd rather have two independent 1:1 DMs. What changed:

- The shared room `!TFczfuGKUOlgTPhzWO:thehammeredone.ddns.net` was left dormant after the pivot (only `@aurora` + `@hammer` joined, Ann's invite retracted). **2026-07-26: cleaned up** — its `messaging_groups` row (`46298d97-7e51-4a77-85d0-e3ea1b878526`) and wiring (`45d4896e-ef0b-4ac6-aa23-b59ba252e894`) were deleted via `ncl wirings delete` / `ncl messaging-groups delete` once the two-DM design was confirmed as final (YAGNI — it was never going to be revived). The Matrix room itself still exists on the homeserver (harmless, not worth tracking down deletion for) but NanoClaw no longer knows about it or tries to catch up on it.
- hammer's DM: auto-created when he messaged the shared room while it still had only 2 members (`mg-1783608739461-4om0w9`), wired to Aurora.
- ann's DM: created proactively (`f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394`, `is_group=0`, platform_id `matrix:@ann:thehammeredone.ddns.net`), wired to Aurora. Her actual 1:1 room will be created automatically by the adapter's `openDM` the first time either side sends a message.
- **Two bugs found + fixed via live testing** (sent test messages as `@hammer` over the API):
  1. Messages routed to Aurora correctly but replies got silently dropped — Aurora's agent group had zero `destinations` rows. Fixed: `ncl destinations add --agent-group-id ag-1782273071167-th1q6f --local-name hammer --target-type channel --target-id mg-1783608739461-4om0w9` (and same pattern for `ann`).
  2. Once destinations were fixed, Aurora replied but Skylight tools weren't available — the MCP server's `pip install` of the wheel was silently failing on an SSL cert error (needs `fastmcp` from PyPI through the OneCLI proxy, and pip doesn't honor the JS/Deno-oriented `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` env vars). Fixed by adding `PIP_CERT=/tmp/onecli-combined-ca.pem` to the skylight MCP server's env, both in `scripts/setup-aurora-agent.ts` and live via `ncl groups config add-mcp-server`.
- Also found: hammer's and ann's *Matrix* identities needed explicit `ncl members add` on Aurora's agent group — privilege doesn't cross channel identities (hammer's Discord owner role doesn't apply to his separate `matrix:@hammer:...` user row).
- End-to-end test succeeded: weather came back correctly in a real Matrix reply. Calendar/Chores are separately broken — Skylight auth token needs refreshing (pre-existing issue, see `project_aurora_agent` memory / this file's Step 3 area is unrelated to that).

### Current blocker: local DNS negative-cache (not the domain/port-forward)

The domain and port-forward are confirmed working — external DoH (1.1.1.1, 8.8.8.8) resolves `thehammeredone.ddns.net` correctly, and a manual TLS connection using `curl --resolve` reaches Synapse cleanly. But the NanoClaw **host process** (running inside WSL2) fails with `fetch failed` on startup because the WSL-side resolver (`10.255.255.254`) returns a cached **NODATA** response (SOA authority `nf1.no-ip.com`, TTL ~18-21 min as of 2026-07-09 14:44 UTC) — a stale negative cache from before the domain was recreated, sitting upstream of the Windows box (router or ISP resolver), not fixed by `ipconfig /flushdns`.

**Update 15:00 UTC:** waiting did NOT fully fix it. After the SOA TTL window passed, resolution improved but is still flaky (~60% success rate measured over 10 tries, 1s apart — `for i in $(seq 1 10); do python3 -c "import socket; socket.gethostbyname('thehammeredone.ddns.net')" 2>/dev/null && echo ok || echo fail; sleep 1; done`). A one-off request (like the cert issuance) can succeed on a lucky attempt, but the Matrix adapter's `/sync` long-poll fires constantly and needs resolution to succeed essentially every time to stay connected — so it degrades into a `sync error` / reconnect loop (`Number of consecutive failed sync requests: N`) instead of running cleanly. A test message sent via the API (as `@hammer`) did not make it through to Aurora because of this.

**Real fix: pin `/etc/hosts`.** This bypasses the flaky WSL/upstream resolver chain entirely for this one hostname. Requires `sudo` — not available non-interactively in the Claude Code environment, so a human needs to run this once:
```bash
echo "73.175.105.180 thehammeredone.ddns.net" | sudo tee -a /etc/hosts
systemctl --user restart nanoclaw-v2-b3501fc6
tail -f logs/nanoclaw.error.log | grep -i matrix   # should show no new errors
tail -f logs/nanoclaw.log | grep -i matrix         # look for "Matrix sync ready" with no subsequent "sync error" lines
```
**Caveat:** this pins the IP statically. If the DDNS IP ever changes (dynamic WAN IP), this entry goes stale and needs manual updating — check `curl -s ifconfig.me` against the hosts entry if Matrix connectivity breaks again later. Remove the line entirely if/once the underlying resolver issue is fixed at the network level (e.g., pointing the router/Windows adapter's DNS at 1.1.1.1/8.8.8.8 instead of the ISP-assigned resolver, which is the actual root cause but out of scope to change from inside WSL).

### Update 2026-07-26: resumed after a 16-day gap, fixed a catch-up bug

The nanoclaw host process itself had been down since ~2026-07-10 11:10 (no crash-loop, no error — the box was simply off; log history shows a clean gap with no adapter activity of any kind, not just Matrix). Restarting the service today (`systemctl --user restart nanoclaw-v2-b3501fc6`) brought Matrix back up cleanly on the first try — no DNS negative-cache issue this time, `Matrix sync ready` and live message delivery to hammer's DM confirmed within seconds.

While verifying, found and fixed a real bug: on every restart, `catchUpMissedMessages` (`src/index.ts`) calls the adapter's `fetchChannelMessages` directly with the stored `messaging_groups.platform_id`. For Matrix DMs that's the user-handle form (`matrix:@hammer:...`), but the underlying `@beeper/chat-adapter-matrix` `fetchChannelMessages` expects a real room ID and doesn't know about NanoClaw's DM-resolution scheme — it decoded the handle as a literal (non-existent) room and got a `403`. `src/channels/matrix.ts`'s `wrapWithDmResolution` already resolved this correctly for `postMessage`/`startTyping`/`channelIdFromThreadId` but not for `fetchChannelMessages`. Fixed by wrapping it the same way (resolve user handle → real room via `openDM` before delegating). Verified via restart: both hammer's and ann's DM catch-up now succeed instead of 403ing.

One remaining, unrelated 403: catch-up for the dormant shared room (`!TFczfuGKUOlgTPhzWO`) still fails because `@aurora` is apparently no longer joined to it. Since that room is intentionally unused (see Design pivot above), this was left alone rather than fixed.

---

## Step 1 — Unblock the cert (user action required on Windows side)

Before touching anything in the terminal, confirm these three things are done:

1. **DynDNS record points to your current WAN IP.**
   - Find your WAN IP: `curl -s ifconfig.me`
   - Confirm DNS: `nslookup thehammeredone.ddns.net` (from any machine/phone)
   - They must match. If your DynDNS client isn't running, update the record manually at your DynDNS provider.

2. **Router port-forward active:** WAN port 443 → your PC's LAN IP, port 443.

3. **Windows Firewall allows inbound 443:**
   ```powershell
   # Run in PowerShell as admin (if not already done)
   New-NetFirewallRule -DisplayName "Matrix HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
   ```

4. **WSL mirrored networking enabled** (`%UserProfile%\.wslconfig` has `networkingMode=mirrored` under `[wsl2]`). If you changed this, you ran `wsl --shutdown` and reopened WSL.

---

## Step 2 — Verify the cert issued

Check Caddy logs (it retries every 60s automatically):

```bash
cd ~/matrix-stack && docker compose logs caddy --follow
```

Look for: `"msg":"certificate obtained successfully"` for `thehammeredone.ddns.net`.

Then verify from outside your network (phone on cellular, or a public checker):

```bash
curl -s https://thehammeredone.ddns.net/_matrix/client/versions | head -c 100
```

Should return JSON like `{"versions":["r0.0.1",...]}` with a valid TLS cert (no warnings).

---

## Step 3 — Create accounts (Phase B) ✅ DONE 2026-07-09

All three accounts registered; Aurora's token captured (`user_id: @aurora:thehammeredone.ddns.net`, `device_id: JDPGMHZSMJ`). Passwords generated randomly this session — not stored in the repo; ask in-conversation history or reset via `register_new_matrix_user` (idempotent, re-running with a new `-p` resets the password) if lost. `docker exec` did NOT need `-it` — plain `docker exec matrix-stack-synapse-1 register_new_matrix_user ...` worked fine non-interactively since `-p`/`-a`/`--no-admin` fully specify the inputs.

Register the three Matrix users via Synapse's admin tool:

```bash
# Register @Hammer (admin)
docker exec -it matrix-stack-synapse-1 \
  register_new_matrix_user -c /data/homeserver.yaml \
  -u hammer -p '<choose a password>' -a http://localhost:8008

# Register @Ann (non-admin)
docker exec -it matrix-stack-synapse-1 \
  register_new_matrix_user -c /data/homeserver.yaml \
  -u ann -p '<choose a password>' --no-admin http://localhost:8008

# Register @aurora bot (non-admin)
docker exec -it matrix-stack-synapse-1 \
  register_new_matrix_user -c /data/homeserver.yaml \
  -u aurora -p '<choose a password>' --no-admin http://localhost:8008
```

Then capture Aurora's **access token** (preferred over storing the password long-term):

```bash
curl -s -XPOST https://thehammeredone.ddns.net/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"aurora"},"password":"<aurora password>"}' \
  | python3 -m json.tool
```

Save from the response:
- `access_token` → goes in NanoClaw `.env` as `MATRIX_ACCESS_TOKEN`
- `device_id` → goes in `.env` as `MATRIX_DEVICE_ID`

---

## Step 4 — Install the Matrix adapter into NanoClaw (Phase C) ✅ DONE 2026-07-09

`bash setup/install-matrix.sh` ran clean (fetched `src/channels/matrix.ts` + `matrix-registration.test.ts` from `channels` branch, installed `@beeper/chat-adapter-matrix@0.2.0`, patched ESM extensions, built). Credentials written to `.env` + `data/env/env`, host restarted. ⚠️ Adapter currently fails with `fetch failed` on startup — this is the DNS negative-cache issue described at the top of this doc, not an install problem. Re-run `systemctl --user restart nanoclaw-v2-b3501fc6` once that clears.

```bash
cd /home/hammer/git/nanoclaw-v2

# Install from the channels branch (idempotent)
bash setup/install-matrix.sh
```

If `setup/install-matrix.sh` doesn't exist yet (it's on the `channels` branch), do it manually:
```bash
git fetch origin channels
git show origin/channels:src/channels/matrix.ts > src/channels/matrix.ts
git show origin/channels:setup/install-matrix.sh > /tmp/install-matrix.sh
bash /tmp/install-matrix.sh
```

Then add bot credentials to `.env`:

```bash
cat >> .env << 'EOF'
MATRIX_BASE_URL=https://thehammeredone.ddns.net
MATRIX_ACCESS_TOKEN=<aurora's access_token from Step 3>
MATRIX_USER_ID=@aurora:thehammeredone.ddns.net
MATRIX_BOT_USERNAME=Aurora
MATRIX_DEVICE_ID=<device_id from Step 3>
EOF

# Materialize where the host actually reads it
mkdir -p data/env && cp .env data/env/env
```

Restart the host:
```bash
systemctl --user restart nanoclaw-v2-b3501fc6
```

Check logs for matrix adapter init:
```bash
tail -f logs/nanoclaw.log | grep -i matrix
```
Look for: `matrix adapter initialized` and `sync PREPARED`.

---

## Step 5 — Create the room and wire it (Phase D) ✅ DONE 2026-07-09

Done via the Matrix Client-Server API directly (using Aurora's access token) rather than the Element GUI — faster and scriptable:
```bash
curl -s -XPOST https://thehammeredone.ddns.net/_matrix/client/v3/createRoom \
  -H "Authorization: Bearer <aurora access_token>" -H 'Content-Type: application/json' \
  -d '{"name":"Morning Briefing","topic":"Aurora morning report",
       "invite":["@hammer:thehammeredone.ddns.net","@ann:thehammeredone.ddns.net"],
       "visibility":"private","creation_content":{"m.federate":false}}'
```
Room ID: `!TFczfuGKUOlgTPhzWO:thehammeredone.ddns.net`. Confirmed unencrypted (`GET .../state/m.room.encryption` → `M_NOT_FOUND`, as expected). `@hammer` and `@ann` are invited but have not yet accepted (they'll do that from Element in Step 6).

`ncl users create` needs `--kind` (not just `--id`/`--display-name`); `ncl members add` takes `--user`/`--group` shorthand (the `--user-id`/`--agent-group-id` long forms in `ncl members help`'s Fields table also work). Actual commands run:
```bash
ncl users create --id "matrix:@ann:thehammeredone.ddns.net" --kind matrix --display-name "Ann"
ncl members add --user "matrix:@ann:thehammeredone.ddns.net" --group ag-1782273071167-th1q6f

ncl messaging-groups create \
  --channel-type matrix \
  --platform-id "matrix:!TFczfuGKUOlgTPhzWO:thehammeredone.ddns.net" \
  --name "skylight-matrix" \
  --is-group 1 \
  --unknown-sender-policy strict
# -> messaging_group id 46298d97-7e51-4a77-85d0-e3ea1b878526

ncl wirings create \
  --messaging-group-id 46298d97-7e51-4a77-85d0-e3ea1b878526 \
  --agent-group-id ag-1782273071167-th1q6f \
  --engage-mode pattern \
  --engage-pattern "." \
  --session-mode per-thread
# -> wiring id 45d4896e-ef0b-4ac6-aa23-b59ba252e894
```

---

## Step 6 — Mobile client setup and end-to-end test (Phase E) — REMAINING (hand-off)

Both remaining items need physical access to a phone, so neither can be automated further. Note the design pivot above: there is no "Morning Briefing" room to join anymore — each person talks to Aurora in their own private 1:1 DM, which the adapter auto-creates on first message either direction.

### 6a. Ann's iPhone (Element / Element X)

1. Ann installs **Element X** (preferred) or Element from the App Store.
2. Sign in with `@ann:thehammeredone.ddns.net` — tap "Other" / "I have an account" and enter the homeserver URL `https://thehammeredone.ddns.net`.
3. Her DM with `@aurora:thehammeredone.ddns.net` should appear automatically (messaging_group `f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394` is already wired) — if not yet created, send Aurora a message from the API once to trigger `openDM`, or have her start the DM herself from Element.
4. **Test:** Send "good morning" in the DM.
   - Expected: Aurora wakes, calls the Skylight tools, replies with a formatted morning report.
5. **Test on cellular:** Have Ann take her phone off wifi and send a message. Confirm push notification arrives.

### 6b. Hammer's Android phone (Element / Element X)

Mirrors 6a for `@hammer:thehammeredone.ddns.net` — his DM (`mg-1783608739461-4om0w9`) is already wired and has been tested end-to-end from the host/API, but no mobile client has been signed in yet.

1. Install **Element X** (preferred) or Element from the Play Store.
2. Sign in with `@hammer:thehammeredone.ddns.net` — tap "Other" / "I have an account" and enter the homeserver URL `https://thehammeredone.ddns.net`. Password was generated during original setup (see Step 3 note — given in-conversation only, reset via `register_new_matrix_user` if lost).
3. The existing DM with `@aurora:thehammeredone.ddns.net` should show up in the room list immediately (it already has message history).
4. **Test:** Send "good morning" in the DM and confirm a report comes back.
5. **Test on cellular:** Take the phone off wifi, send a message, confirm push notification arrives.
6. Optional: set `@hammer:thehammeredone.ddns.net` as the primary account if Element is also used for other homeservers, or keep it as a secondary account — either works.

---

## Key facts for the next session

| Item | Value |
|------|-------|
| Aurora agent group ID | `ag-1782273071167-th1q6f` |
| Aurora folder | `groups/skylight-morning/` |
| nanoclaw service name | `nanoclaw-v2-b3501fc6` |
| Matrix stack path | `~/matrix-stack/` |
| Homeserver URL | `https://thehammeredone.ddns.net` |
| server_name (permanent) | `thehammeredone.ddns.net` |
| Bot account | `@aurora:thehammeredone.ddns.net` |
| Discord #skylight wiring | `f75dc4b4-b9ef-4d60-b9f8-af1abcea85f2` |
| Postgres password | In `~/matrix-stack/.env` |
| Synapse signing key | `~/matrix-stack/synapse-data/thehammeredone.ddns.net.signing.key` — never delete |
| Morning Briefing room ID (dormant, deleted from NanoClaw 2026-07-26) | `!TFczfuGKUOlgTPhzWO:thehammeredone.ddns.net` |
| hammer DM messaging_group id | `mg-1783608739461-4om0w9` |
| ann DM messaging_group id | `f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394` |
| Account passwords | Generated 2026-07-09, given to Hammer in-conversation only — not in this repo. Reset any of them with `docker exec matrix-stack-synapse-1 register_new_matrix_user -c /data/homeserver.yaml -u <user> -p '<new password>' [-a\|--no-admin] http://localhost:8008` (re-running is idempotent and overwrites the password). |

## Stack management

```bash
cd ~/matrix-stack
docker compose up -d        # start
docker compose down         # stop (keeps data)
docker compose down -v      # DESTRUCTIVE — wipes all data
docker compose logs -f      # follow all logs
docker compose logs synapse # synapse only
docker compose logs caddy   # caddy / cert status
```

## If the cert never issues

Caddy retries indefinitely. Check in order:
1. `nslookup thehammeredone.ddns.net` — must resolve to your WAN IP.
2. Test port 443 reachability from outside: `curl -v https://thehammeredone.ddns.net/_matrix/client/versions` from a phone on cellular.
3. Check Windows Firewall isn't blocking 443.
4. Check router port-forward rule is saved and active (some routers require a reboot).
5. `docker compose logs caddy` — the error message is always specific about what failed.
