import type { ModuleMigration } from '../../db/migrations/index.js';

export const desktopRoomsMigration: ModuleMigration = {
  version: 1,
  name: 'module:desktop:rooms-v1',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_rooms (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_room_agents (
        room_id TEXT NOT NULL REFERENCES desktop_rooms(id),
        agent_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        messaging_group_id TEXT NOT NULL UNIQUE REFERENCES messaging_groups(id) ON DELETE CASCADE,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(room_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS desktop_room_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL REFERENCES desktop_rooms(id), thread_id TEXT,
        author_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_name TEXT NOT NULL,
        text TEXT NOT NULL, targets TEXT NOT NULL, fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS desktop_room_history ON desktop_room_messages(room_id, seq);
      CREATE TABLE IF NOT EXISTS desktop_room_outbox (
        message_id TEXT NOT NULL REFERENCES desktop_room_messages(id),
        agent_id TEXT NOT NULL, targeted INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT, PRIMARY KEY(message_id, agent_id)
      );
    `);
  },
};
