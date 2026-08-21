---
id: TASK-4
title: Resume Matrix homeserver setup for Aurora
status: Done
assignee: []
created_date: '2026-07-09 14:31'
updated_date: '2026-08-21 01:02'
labels:
  - matrix
  - aurora
  - infra
  - skylight
dependencies:
  - TASK-1
references:
  - docs/runbooks/matrix-homeserver-resume.md
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Runbook: docs/runbooks/matrix-homeserver-resume.md

Self-hosted Matrix homeserver setup (Aurora -> Ann's iPhone via Element) stalled at the Let's Encrypt cert step. Postgres/Synapse/Caddy are up; Caddy is retrying ACME every 60s but blocked on DNS not resolving / port-forward not active for thehammeredone.ddns.net:443.

Remaining phases per runbook:
- Step 1: unblock cert (DynDNS record, router port-forward 443, Windows Firewall rule, WSL mirrored networking)
- Step 2: verify cert issued
- Step 3: register Matrix accounts (@hammer, @ann, @aurora) + capture Aurora access token
- Step 4: install Matrix adapter into NanoClaw, wire .env, restart host
- Step 5: create Matrix room, wire messaging group + agent group (ag-1782273071167-th1q6f)
- Step 6: Ann sets up Element on iPhone + Hammer sets up Element on Android, end-to-end test each (wifi + cellular push)

Stack lives outside repo at ~/matrix-stack/ (docker compose).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-07-09: Steps 1-2 confirmed working. User recreated the DDNS domain + confirmed port-forward. Verified DNS propagated externally (1.1.1.1/8.8.8.8 DoH), port 443 reachable, and forcing a Caddy restart triggered an immediate successful production Let's Encrypt cert issuance (acme-v02, tls-alpn-01, ~3s). https://thehammeredone.ddns.net/_matrix/client/versions returns clean HTTP/2 200 from Synapse 1.155.0 with a trusted cert.

2026-07-09 (part 2): Pushed through steps 3-5 autonomously. Registered @hammer/@ann/@aurora Matrix accounts, captured Aurora's access token, installed the Matrix adapter (setup/install-matrix.sh), wired credentials into .env, created the room via API as Aurora (!TFczfuGKUOlgTPhzWO:thehammeredone.ddns.net, unencrypted, non-federated, hammer+ann invited), registered Ann in NanoClaw (matrix:@ann:thehammeredone.ddns.net), and created the messaging_group (46298d97-7e51-4a77-85d0-e3ea1b878526) + wiring (45d4896e-ef0b-4ac6-aa23-b59ba252e894) to ag-1782273071167-th1q6f.

2026-07-09 (part 3): DNS blocker is worse than initially assessed - it's flaky (~60% resolution success), not a clean one-time negative cache that fully clears. WSL's DNS proxy (10.255.255.254) initially returned a stale NODATA response (SOA authority nf1.no-ip.com) even though external DoH resolvers resolved correctly; ipconfig /flushdns (via WSL interop) didn't fix it since the cache is upstream of Windows. After waiting past the SOA TTL, resolution improved but stayed flaky (~60% success over 10 tries). A one-off request (like cert issuance) can succeed on a lucky attempt, but the Matrix /sync long-poll needs resolution to succeed nearly every time to stay connected, so it degrades into a reconnect loop ('consecutive failed sync requests') instead of running cleanly. A live end-to-end test (joined @hammer to the room via API, sent 'good morning') did NOT reach Aurora because of this.

Real fix needs sudo (not available non-interactively in this environment): 'echo "73.175.105.180 thehammeredone.ddns.net" | sudo tee -a /etc/hosts' then 'systemctl --user restart nanoclaw-v2-b3501fc6'. Caveat: pins the IP statically, will go stale if the DDNS IP changes later. This is now the single blocking action needed from Hammer before Step 6 (Ann's iPhone) can be meaningfully tested. Full details + every command run: docs/runbooks/matrix-homeserver-resume.md.

2026-07-09 (part 4): User decided two separate DMs (hammer + ann) are preferred over the shared 'Morning Briefing' group room. Wired both: created ncl wiring for the auto-created hammer DM messaging group (mg-1783608739461-4om0w9), preemptively created + wired Ann's DM messaging group (f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394). Retracted Ann's invite to the shared room (kicked via Aurora's admin token) since the Matrix adapter's isDM heuristic (src/channels/matrix.ts:117-129) treats any room with <=2 joined members as a DM keyed by user handle - if Ann had joined that room too it would've flipped to group classification and broken hammer's DM routing.

Two real bugs found + fixed via live end-to-end testing (sent test messages as hammer):
1. Messages routed correctly but got silently dropped - agent had no registered destinations. Fixed: ncl destinations add for both hammer and ann local-names pointing at their DM messaging groups.
2. Skylight MCP server's pip install silently failed (SSL cert verify failed against OneCLI proxy's self-signed cert when fetching the fastmcp dependency from PyPI) - venv got created but skylight package never installed, so the MCP server exec'd anyway with a broken environment. Root cause: pip doesn't honor NODE_EXTRA_CA_CERTS/SSL_CERT_FILE (JS/Deno-only), needs PIP_CERT or REQUESTS_CA_BUNDLE. Fixed both the live container (manual pip install with PIP_CERT set) and the source (scripts/setup-aurora-agent.ts now sets PIP_CERT: /tmp/onecli-combined-ca.pem in the skylight MCP server's env) and pushed the same via ncl groups config add-mcp-server so it's live without needing a rebuild.

End-to-end test SUCCEEDED after both fixes: sent 'give me my morning report' as hammer, got a real weather briefing back in the Matrix DM room. However, Calendar and Chores sections came back as unavailable - Skylight auth token appears expired/disconnected (separate, pre-existing issue unrelated to Matrix - see project_aurora_agent memory's token refresh note). Weather (no-auth-required) worked fine, proving the full pipeline (routing -> destinations -> Skylight MCP -> delivery) is solid.

Remaining: Step 6 (Ann's iPhone) unchanged - still needs physical device setup. Additionally Skylight token needs refreshing before the report is fully useful (separate task).

2026-07-26: Host had been down since 2026-07-10 (~16 days, no crash - box was just off); restarted cleanly, Matrix reconnected on the first try. Found and fixed a real bug in the DM-resolution wrapper (`src/channels/matrix.ts`): `catchUpMissedMessages` calls `fetchChannelMessages` with the user-handle platform_id, but only `postMessage`/`startTyping`/`channelIdFromThreadId` were wrapped to resolve that to a real room ID - `fetchChannelMessages` wasn't, so every restart's catch-up 403'd on both hammer's and ann's DMs. Fixed by wrapping `fetchChannelMessages` the same way; verified via restart that both DMs now catch up cleanly. Also: Skylight auth moved to persistent email/password (see commit 839d03c), so the token-expiry gap noted above is resolved going forward. Aurora's report-formatting prompt (`groups/skylight-morning/CLAUDE.local.md`) also got a substantial accuracy pass this cycle - calendar timezone/window filtering, chores category switched from "Mom" to "Dad", weather rain-range grouping, added a "Tomorrow's Calendar" section.

Step 6 now has two remaining hand-off items, not one: Ann's iPhone (Element) and, newly added, Hammer's own Android phone (Element) - his DM has been tested end-to-end via API/host but no mobile client has ever been signed in. See runbook Step 6a/6b for both.

PARKED 2026-08-20 by the backlog orchestrator (session fe8a8e37).

Steps 1-5 are complete and verified against the live central DB:
- Homeserver reachable at thehammeredone.ddns.net; the Let's Encrypt / DNS / port-forward
  blocker that stalled Step 1 is resolved (accounts resolve on that domain).
- Matrix adapter installed at src/channels/matrix.ts and self-registered in
  src/channels/index.ts.
- Both DM messaging groups exist:
    mg-1783608739461-4om0w9        matrix:@hammer:thehammeredone.ddns.net
    f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394  matrix:@ann:thehammeredone.ddns.net  'Ann DM'
- Both wired to Aurora (ag-1782273071167-th1q6f), session_mode=shared:
    35671fb9-b06c-4e77-a6b3-5d3d3e7bba34  -> hammer DM
    95b041ba-7a62-4d03-82a6-c961bb1f76af  -> Ann DM
- Hammer's session sess-1783609624398-smn6q9 is live (last_active 2026-08-20T11:19:53Z).

Only Step 6 remains: Ann sets up Element on her iPhone, Hammer on Android, and each is
end-to-end tested on wifi and cellular push. Ann's wiring has never instantiated a session,
which is consistent with Element not yet being set up on her device.

This cannot be automated -- it needs two physical phones and Ann. Moved out of 'In Progress'
to 'Needs Review' so the orchestrator's next-task selector (orchestrate.py:157 returns any
In Progress task as 'resume', with no blocked state) can advance past it instead of
deadlocking the run. Move it back to 'To Do'/'In Progress' when the devices are in hand.

CLOSED 2026-08-20 by operator decision. Ann has completed the Element install on her iPhone, which was the only outstanding item (Step 6). Steps 1-5 were already verified complete against the live central DB earlier in this session: homeserver reachable at thehammeredone.ddns.net, Matrix adapter installed and self-registered, both DM messaging groups present, both wired to Aurora, and Hammer's session live.

Note carried forward: as of this session, messages_out across every Aurora session contained ZERO rows ever delivered to matrix:@ann:... The wiring and destination exist, but Aurora's CLAUDE.local.md never instructs it to send to Ann, so nothing has ever reached her. Ann having Element installed does not by itself change that. See TASK-23 (clone Aurora onto its own agent group for Ann's DM), which is the task that actually gives her a working agent.
<!-- SECTION:NOTES:END -->
