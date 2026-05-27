#!/usr/bin/env bash
# sessions-named — like `ncl sessions list` but with names instead of UUIDs
set -euo pipefail

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

ncl groups list          > "$tmpdir/groups.txt"
ncl messaging-groups list > "$tmpdir/mg.txt"
ncl sessions list         > "$tmpdir/sessions.txt"

python3 - "$tmpdir/groups.txt" "$tmpdir/mg.txt" "$tmpdir/sessions.txt" <<'PYEOF'
import sys

def parse_table(path):
    with open(path) as f:
        lines = f.read().strip().split('\n')
    if len(lines) < 2:
        return []
    sep = lines[1]
    # find column starts from separator (─ characters)
    col_starts, in_dash = [], False
    for i, c in enumerate(sep):
        if c == '─' and not in_dash:
            col_starts.append(i)
            in_dash = True
        elif c != '─':
            in_dash = False
    headers = []
    for i, start in enumerate(col_starts):
        end = col_starts[i + 1] if i + 1 < len(col_starts) else None
        headers.append(lines[0][start:end].strip())
    rows = []
    for line in lines[2:]:
        if not line.strip():
            continue
        row = {}
        for i, start in enumerate(col_starts):
            end = col_starts[i + 1] if i + 1 < len(col_starts) else None
            row[headers[i]] = line[start:end].strip() if start < len(line) else ''
        rows.append(row)
    return rows

groups   = parse_table(sys.argv[1])
mgs      = parse_table(sys.argv[2])
sessions = parse_table(sys.argv[3])

group_name = {g['id']: g['name'] for g in groups}
# messaging groups are one chat/channel on one platform
mg_label   = {m['id']: f"{m['name']} [{m['channel_type']}]" for m in mgs}

def fmt_thread(t):
    if not t:
        return '—'
    parts = t.split(':')
    platform = parts[0]
    # 4-part = platform:server:channel:thread
    if len(parts) >= 4:
        return f"{platform}/thread:{parts[-1][-8:]}"
    # 3-part = platform:server:channel (channel-level thread session)
    if len(parts) == 3:
        return f"{platform}/ch:{parts[-1][-8:]}"
    return t

def fmt_time(t):
    return t[:16].replace('T', ' ') if t else '—'

COLS = ['session', 'agent', 'channel', 'thread', 'status', 'container', 'last_active']
rows_out = []
for s in sessions:
    rows_out.append([
        s['id'],
        group_name.get(s['agent_group_id'], s['agent_group_id']),
        mg_label.get(s['messaging_group_id'], s['messaging_group_id'] or '—'),
        fmt_thread(s.get('thread_id', '')),
        s['status'],
        s['container_status'],
        fmt_time(s.get('last_active', '')),
    ])

widths = [max(len(str(r[i])) for r in ([COLS] + rows_out)) for i in range(len(COLS))]

def fmt_row(row, sep='  '):
    return sep.join(str(v).ljust(widths[i]) for i, v in enumerate(row))

print(fmt_row(COLS))
print('  '.join('─' * w for w in widths))
for row in rows_out:
    print(fmt_row(row))
PYEOF
