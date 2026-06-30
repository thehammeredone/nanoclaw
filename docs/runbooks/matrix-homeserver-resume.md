# Runbook: Resume Matrix Homeserver Setup

**Context:** Self-hosted Matrix homeserver for Aurora (morning report assistant) → Ann's iPhone via Element iOS.
**Plan file:** `/home/hammer/.claude/plans/glittery-sprouting-sketch.md`
**Stack location:** `~/matrix-stack/` (outside the nanoclaw repo, not in git)
**Homeserver URL:** `https://thehammeredone.ddns.net`

---

## Current state (as of 2026-06-25)

| Component | Status |
|-----------|--------|
| Postgres | ✅ Running and healthy |
| Synapse | ✅ Running and healthy |
| Caddy | ✅ Running — retrying ACME cert every 60s |
| Let's Encrypt cert | ❌ Blocked — DNS not resolving / port-forward not active |
| Matrix adapter in NanoClaw | ❌ Not yet installed |
| Matrix room + wiring | ❌ Not yet created |
| Ann's iPhone (Element) | ❌ Not yet set up |

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

## Step 3 — Create accounts (Phase B)

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

## Step 4 — Install the Matrix adapter into NanoClaw (Phase C)

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

## Step 5 — Create the room and wire it (Phase D)

1. Open **Element** (desktop or web) signed in as `@hammer:thehammeredone.ddns.net`.
2. Create a new room — name it something like "Morning Briefing". **Leave encryption OFF.**
3. Invite `@ann:thehammeredone.ddns.net` and `@aurora:thehammeredone.ddns.net`.
   - Aurora auto-joins (MATRIX_INVITE_AUTOJOIN defaults on).
4. Get the room ID: In Element → Room Settings → Advanced → Internal room ID. It looks like `!abc123:thehammeredone.ddns.net`.
5. Register Ann as a known user in NanoClaw:
   ```bash
   ncl users create --id "matrix:@ann:thehammeredone.ddns.net" --display-name "Ann"
   ncl members add --agent-group-id ag-1782273071167-th1q6f --user-id "matrix:@ann:thehammeredone.ddns.net"
   ```
6. Create the messaging group + wiring:
   ```bash
   ncl messaging-groups create \
     --channel-type matrix \
     --platform-id "matrix:!<roomid>:thehammeredone.ddns.net" \
     --name "skylight-matrix" \
     --is-group 1 \
     --unknown-sender-policy strict

   # Use the mg-id from the output above
   ncl wirings create \
     --messaging-group-id <mg-id> \
     --agent-group-id ag-1782273071167-th1q6f \
     --engage-mode pattern \
     --engage-pattern "." \
     --session-mode per-thread
   ```

---

## Step 6 — iPhone setup and end-to-end test (Phase E)

1. Ann installs **Element X** (preferred) or Element from the App Store.
2. Sign in with `@ann:thehammeredone.ddns.net` — tap "Other" / "I have an account" and enter the homeserver URL `https://thehammeredone.ddns.net`.
3. Join the "Morning Briefing" room and allow notifications.
4. **Test:** Send "good morning" in the room.
   - Expected: Aurora wakes, calls 4 Skylight tools (calendar, chores, categories, reward points), replies with a formatted morning report.
5. **Test on cellular:** Have Ann take her phone off wifi and send a message. Confirm push notification arrives.

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
