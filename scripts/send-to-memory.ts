/**
 * Send a message to the Memory agent's inbound DB.
 * The sweep picks it up within 60 seconds — no explicit wake needed.
 *
 * Usage:
 *   pnpm exec tsx scripts/send-to-memory.ts "your message text"
 *   echo "your message" | pnpm exec tsx scripts/send-to-memory.ts
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

const CENTRAL_DB = 'data/v2.db';
const SESSIONS_DIR = 'data/v2-sessions';
const MEMORY_AGENT_GROUP_ID = 'f09aa5a1-bea7-410a-a319-f20da1549703';

// Resolve message text: CLI arg, then stdin
let text = process.argv[2];
if (!text) {
  try {
    text = readFileSync('/dev/stdin', 'utf8').trim();
  } catch {
    // ignore
  }
}
if (!text) {
  console.error('Usage: send-to-memory.ts "<message>" or pipe via stdin');
  process.exit(1);
}

// Find the active session for the Memory agent group
const central = new Database(CENTRAL_DB, { readonly: true });
const session = central
  .prepare("SELECT id, agent_group_id FROM sessions WHERE agent_group_id=? AND status='active' ORDER BY created_at DESC LIMIT 1")
  .get(MEMORY_AGENT_GROUP_ID) as { id: string; agent_group_id: string } | undefined;
central.close();

if (!session) {
  console.error(`No active session for Memory agent group ${MEMORY_AGENT_GROUP_ID}`);
  process.exit(1);
}

const inboundPath = join(SESSIONS_DIR, session.agent_group_id, session.id, 'inbound.db');
const db = new Database(inboundPath);
try {
  const maxSeq = (db.prepare('SELECT max(seq) as m FROM messages_in').get() as any).m ?? 0;
  const seq = maxSeq % 2 === 0 ? maxSeq + 2 : maxSeq + 1; // host uses even seqs
  const id = `host-${Date.now()}-msg`;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
     VALUES (?, ?, 'chat', datetime('now'), 'pending', 1, ?)`,
  ).run(id, seq, JSON.stringify({ text }));
  console.log(`Sent to Memory (session ${session.id}, seq ${seq})`);
  console.log(`Sweep will wake the container within 60s.`);
} finally {
  db.close();
}
