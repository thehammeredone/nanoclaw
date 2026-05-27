import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'message-catchup',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE messaging_groups ADD COLUMN last_seen_message_id TEXT').run();
  },
};
