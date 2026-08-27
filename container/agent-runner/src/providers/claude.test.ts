import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ClaudeProvider } from './claude.js';

// TASK-28: archiveSession() is the daily-rollover writer — a separate path
// from the PreCompact hook (which is untouched by this task). These tests
// exercise it against a temp CLAUDE_CONFIG_DIR (the SDK's own documented
// override for where it reads/writes session transcripts — see the SDK's
// SessionStore doc comment: "set CLAUDE_CONFIG_DIR=/tmp for ephemeral local
// copy") and a temp cwd, so nothing here ever touches a real
// groups/<folder>/conversations/ directory or the real ~/.claude/projects.

let configDir: string;
let cwd: string;
let prevConfigDir: string | undefined;

const SESSION_ID = '12345678-1234-1234-1234-123456789012';

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cwd-'));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** Write a minimal valid Claude Code session transcript the SDK's
 * getSessionMessages() can parse: a two-entry user→assistant parentUuid
 * chain under some arbitrary project directory. */
function writeFixtureTranscript(sessionId: string, opts?: { userText?: string; assistantText?: string }): void {
  const projectDir = path.join(configDir, 'projects', 'test-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const userUuid = 'aaaaaaaa-0000-0000-0000-000000000001';
  const assistantUuid = 'aaaaaaaa-0000-0000-0000-000000000002';
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: userUuid,
      parentUuid: null,
      sessionId,
      timestamp: '2026-08-25T06:00:00.000Z',
      message: { role: 'user', content: opts?.userText ?? 'Run the daily report' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: assistantUuid,
      parentUuid: userUuid,
      sessionId,
      timestamp: '2026-08-25T06:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: opts?.assistantText ?? 'Report done.' }] },
    }),
  ];
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

function conversationsFiles(): string[] {
  const dir = path.join(cwd, 'conversations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

describe('ClaudeProvider.archiveSession (rollover archiving)', () => {
  it('archives a valid transcript to <cwd>/conversations/<date>-rollover-<sessionId>.md', async () => {
    writeFixtureTranscript(SESSION_ID);
    const provider = new ClaudeProvider({ assistantName: 'Aurora' });

    await provider.archiveSession(SESSION_ID, cwd);

    const files = conversationsFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-rollover-12345678-1234-1234-1234-123456789012\.md$/);

    const content = fs.readFileSync(path.join(cwd, 'conversations', files[0]), 'utf-8');
    expect(content).toContain('Run the daily report');
    expect(content).toContain('Report done.');
    expect(content).toContain('Aurora');
  });

  it('naming rule: the rollover- prefix never collides with PreCompact-style names', () => {
    // PreCompact (see createPreCompactHook, untouched by this task) names
    // files either `<date>-<slugified-summary>.md` or
    // `<date>-conversation-HHMM.md` — never starting with "rollover-".
    // This is the whole collision-avoidance contract for AC#2: assert it
    // directly so a future rename of either scheme trips this test.
    const rolloverName = `2026-08-25-rollover-${SESSION_ID}.md`;
    const preCompactSlugName = '2026-08-25-daily-standup-notes.md';
    const preCompactFallbackName = '2026-08-25-conversation-0600.md';
    expect(rolloverName.includes('-rollover-')).toBe(true);
    expect(preCompactSlugName.includes('-rollover-')).toBe(false);
    expect(preCompactFallbackName.includes('-rollover-')).toBe(false);
  });

  it('idempotent: a second archiveSession() call for the same session is a no-op, never overwrites', async () => {
    writeFixtureTranscript(SESSION_ID);
    const provider = new ClaudeProvider({});

    await provider.archiveSession(SESSION_ID, cwd);
    const files1 = conversationsFiles();
    expect(files1).toHaveLength(1);
    const filePath = path.join(cwd, 'conversations', files1[0]);
    const originalContent = fs.readFileSync(filePath, 'utf-8');
    const originalMtime = fs.statSync(filePath).mtimeMs;

    // Mutate the on-disk transcript so a second real write (if it happened)
    // would produce visibly different content — proves the second call
    // truly skipped rather than coincidentally reproducing the same bytes.
    writeFixtureTranscript(SESSION_ID, { assistantText: 'DIFFERENT CONTENT — should never appear' });

    await provider.archiveSession(SESSION_ID, cwd);

    const files2 = conversationsFiles();
    expect(files2).toHaveLength(1);
    const finalContent = fs.readFileSync(filePath, 'utf-8');
    expect(finalContent).toBe(originalContent);
    expect(finalContent).not.toContain('DIFFERENT CONTENT');
    expect(fs.statSync(filePath).mtimeMs).toBe(originalMtime);
  });

  it('never throws when the session id has no matching transcript', async () => {
    const provider = new ClaudeProvider({});
    // No fixture written for this id.
    await expect(provider.archiveSession('99999999-9999-9999-9999-999999999999', cwd)).resolves.toBeUndefined();
    expect(conversationsFiles()).toHaveLength(0);
  });

  it('never throws when the conversations path is blocked (write failure)', async () => {
    writeFixtureTranscript(SESSION_ID);
    // Pre-create `conversations` as a FILE, not a directory, so mkdirSync
    // fails — simulates a read-only mount / permissions failure without
    // depending on platform-specific chmod semantics.
    fs.writeFileSync(path.join(cwd, 'conversations'), 'not a directory');

    const provider = new ClaudeProvider({});
    await expect(provider.archiveSession(SESSION_ID, cwd)).resolves.toBeUndefined();

    // The blocking file is untouched — no crash, no partial write.
    expect(fs.readFileSync(path.join(cwd, 'conversations'), 'utf-8')).toBe('not a directory');
  });

  it('never throws on a malformed transcript (unparseable JSONL)', async () => {
    const projectDir = path.join(configDir, 'projects', 'test-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), 'not valid json at all\n{"broken":\n');

    const provider = new ClaudeProvider({});
    await expect(provider.archiveSession(SESSION_ID, cwd)).resolves.toBeUndefined();
    expect(conversationsFiles()).toHaveLength(0);
  });
});
