#!/usr/bin/env bash
# Take a restore point of everything the agent-group decommission is about to destroy.
#
#   bash scripts/snapshot-install-state.sh [label]
#
# Writes to data/snapshots/<utc-timestamp>[-label]/ (gitignored) and prints the path.
# Run this BEFORE any task that deletes wirings, sessions, agent groups, group folders,
# or OneCLI vault agents. Git branches protect the repo; nothing protects the live install.
#
# What it captures:
#   v2.db                  consistent copy of the central DB (better-sqlite3 .backup(),
#                          safe against the running host's WAL writes — a plain cp is not)
#   sessions/              every inbound.db / outbound.db, same consistent copy
#   groups.tar.gz          the whole groups/ tree
#   inventory/*.txt        ncl + onecli listings, container and service state
#   RESTORE.md             how to put it back
#
# Deliberately NOT captured: the per-session Skylight venvs (.skylight-venv-*, ~1.5G across
# Aurora's sessions). They are bootstrapped from a wheel on demand and regenerate themselves;
# see TASK-6. Excluding them takes the snapshot from ~1.5G to a few MB.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

LABEL="${1:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP="data/snapshots/${STAMP}${LABEL:+-$LABEL}"
mkdir -p "$SNAP/sessions" "$SNAP/inventory"

echo "==> snapshot: $SNAP"

# --- central DB -------------------------------------------------------------
# .backup() takes a read lock and produces a consistent single file even while the
# host process is mid-transaction. Copying v2.db + -wal + -shm by hand can tear.
node -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
db.backup(process.argv[2]).then(() => { db.close(); }).catch(e => {
  console.error("backup failed:", e.message); process.exit(1);
});
' data/v2.db "$SNAP/v2.db"
echo "    v2.db                      $(du -h "$SNAP/v2.db" | cut -f1)"

# --- session DBs ------------------------------------------------------------
COUNT=0
while IFS= read -r db; do
  rel="${db#data/v2-sessions/}"
  dest="$SNAP/sessions/$rel"
  mkdir -p "$(dirname "$dest")"
  node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  db.backup(process.argv[2]).then(() => { db.close(); }).catch(e => {
    console.error("backup failed:", e.message); process.exit(1);
  });
  ' "$db" "$dest"
  COUNT=$((COUNT + 1))
done < <(find data/v2-sessions -name '*.db' -not -path '*/.skylight-venv-*/*' \
                                            -not -path '*/.skylight-env/*' | sort)
echo "    session DBs                $COUNT files, $(du -sh "$SNAP/sessions" | cut -f1)"

# --- group filesystem -------------------------------------------------------
tar czf "$SNAP/groups.tar.gz" --exclude='node_modules' --exclude='.venv' groups/
echo "    groups.tar.gz              $(du -h "$SNAP/groups.tar.gz" | cut -f1)"

# --- live inventory ---------------------------------------------------------
# Best-effort: a missing daemon must not abort the snapshot. Each capture records
# its own failure into the file so a later restore can tell "empty" from "unavailable".
cap() { # cap <outfile> <cmd...>
  local out="$SNAP/inventory/$1"; shift
  if "$@" >"$out" 2>&1; then :; else echo "(command failed: $*)" >>"$out"; fi
}
cap ncl-groups.txt           ncl groups list
cap ncl-messaging-groups.txt ncl messaging-groups list
cap ncl-wirings.txt          ncl wirings list
cap ncl-destinations.txt     ncl destinations list
cap ncl-users.txt            ncl users list
cap ncl-roles.txt            ncl roles list
cap ncl-members.txt          ncl members list
cap ncl-sessions.txt         ncl sessions list
cap onecli-agents.txt        onecli agents list
cap onecli-secrets.txt       onecli secrets list
cap containers.txt           docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
cap service.txt              systemctl --user status nanoclaw-v2-b3501fc6 --no-pager
cap git.txt                  git log --oneline -5
echo "    inventory                  $(ls "$SNAP/inventory" | wc -l) files"

# --- restore instructions ---------------------------------------------------
cat >"$SNAP/RESTORE.md" <<EOF
# Restore point $STAMP

Taken before destructive decommission work. Repo HEAD at capture: $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD).

## Stop the host first — always

    systemctl --user stop nanoclaw-v2-b3501fc6

Restoring underneath a running host corrupts both copies.

## Central DB

    cp $SNAP/v2.db data/v2.db
    rm -f data/v2.db-wal data/v2.db-shm

Deleting the stale -wal/-shm is required: they belong to the DB you just replaced and
SQLite will otherwise replay them over the restored file.

## Session DBs

    cp -r $SNAP/sessions/<agent-group-id> data/v2-sessions/

Layout under sessions/ mirrors data/v2-sessions/ exactly. The venvs are not in here;
a restored Aurora session rebuilds its .skylight-venv-* on the next container spawn.

## Group filesystem

    tar xzf $SNAP/groups.tar.gz -C .

Overwrites groups/ in place. Files created after the snapshot survive — remove them by
hand if you want an exact rollback.

## OneCLI vault

Vault state is NOT restorable from here. inventory/onecli-agents.txt and
inventory/onecli-secrets.txt record what existed; deleted vault agents must be recreated
via \`onecli agents create\`, and secret assignments re-applied with
\`onecli agents set-secrets\`. Secret *values* are never captured by this script.

## Then

    systemctl --user start nanoclaw-v2-b3501fc6
EOF

echo "==> done: $SNAP ($(du -sh "$SNAP" | cut -f1))"
echo "$SNAP"
