import { createHash, randomUUID } from 'crypto';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupsByAgentGroup,
} from '../../db/messaging-groups.js';
import { canAccessAgentGroup } from '../permissions/access.js';
import { createUser, getUser } from '../permissions/db/users.js';
import type { DesktopRoom, RoomAgent, RoomMessage } from './types.js';

export const CHANNEL = 'desktop';
export const OPERATOR = 'cli:local';
export const uuid = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
  return value.toLowerCase();
};
export function boundedText(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) {
    throw new Error(`${field} must be ${required ? 'non-empty ' : ''}text of at most ${max} characters`);
  }
  return value;
}
export function agentIDs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some((x) => typeof x !== 'string' || !x || x.length > 128)) {
    throw new Error('agent_ids must contain at most 16 agent IDs');
  }
  return [...new Set(value as string[])].sort();
}
export function address(roomID: string, agentID: string): string {
  return `${roomID}/${agentID}`;
}
export async function room(id: string): Promise<DesktopRoom> {
  const r = await getDb().get<DesktopRoom>('SELECT * FROM desktop_rooms WHERE id = ?', id);
  if (!r) throw new Error('Room not found');
  return r;
}
export async function members(id: string): Promise<RoomAgent[]> {
  return getDb().all<RoomAgent>(
    'SELECT * FROM desktop_room_agents WHERE room_id = ? AND active = 1 ORDER BY agent_id',
    id,
  );
}
/** The owner socket is trusted, but joining a room does not grant any agent access. */
export async function requireAgentAccess(id: string): Promise<void> {
  if (!(await getAgentGroup(id))) throw new Error('Agent no longer exists');
  if ((await canAccessAgentGroup(OPERATOR, id)).allowed) return;
  // Match the existing direct-chat contract for an explicitly public, local CLI route.
  const groups = await getMessagingGroupsByAgentGroup(id);
  if (
    groups.some(
      (g) => g.channel_type === 'cli' && g.instance === 'cli' && !g.denied_at && g.unknown_sender_policy === 'public',
    )
  )
    return;
  throw new Error('Local operator needs existing access to this agent before adding it to a room');
}
export async function validateMember(m: RoomAgent): Promise<void> {
  await requireAgentAccess(m.agent_id);
  const mg = await getMessagingGroup(m.messaging_group_id);
  const wirings = await getMessagingGroupAgents(m.messaging_group_id);
  if (
    !mg ||
    mg.denied_at ||
    mg.channel_type !== CHANNEL ||
    mg.instance !== CHANNEL ||
    mg.platform_id !== address(m.room_id, m.agent_id) ||
    mg.is_group !== 1 ||
    mg.unknown_sender_policy !== 'public' ||
    wirings.length !== 1 ||
    wirings[0].agent_group_id !== m.agent_id ||
    wirings[0].engage_mode !== 'mention' ||
    wirings[0].ignored_message_policy !== 'accumulate' ||
    wirings[0].sender_scope !== 'all' ||
    wirings[0].threads !== 1 ||
    wirings[0].session_mode !== 'per-thread'
  ) {
    throw new Error('Room routing changed; reconnect after restoring its dedicated route');
  }
}
export async function snapshot(id: string) {
  const r = await room(id);
  const people = await members(id);
  return { ...r, agent_ids: people.map((m) => m.agent_id), human_ids: [OPERATOR] };
}
export async function addMember(id: string, agentID: string): Promise<void> {
  const existing = await getDb().get<RoomAgent>(
    'SELECT * FROM desktop_room_agents WHERE room_id = ? AND agent_id = ?',
    id,
    agentID,
  );
  if (existing?.active) {
    await validateMember(existing);
    return;
  }
  const mgID = existing?.messaging_group_id ?? randomUUID();
  const now = new Date().toISOString();
  if (!existing)
    await createMessagingGroup({
      id: mgID,
      channel_type: CHANNEL,
      instance: CHANNEL,
      platform_id: address(id, agentID),
      name: `Desktop room · ${(await room(id)).name}`,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now,
    });
  await createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: mgID,
    agent_group_id: agentID,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    threads: 1,
    priority: 0,
    created_at: now,
  });
  await getDb().run(
    `INSERT INTO desktop_room_agents (room_id, agent_id, messaging_group_id, active) VALUES (?, ?, ?, 1)
    ON CONFLICT(room_id, agent_id) DO UPDATE SET active = 1`,
    id,
    agentID,
    mgID,
  );
}
export async function createRoom(args: Record<string, unknown>) {
  const id = uuid(args.id, 'id'),
    name = boundedText(args.name, 'name', 80, true).trim();
  const purpose = boundedText(args.purpose ?? '', 'purpose', 2000),
    ids = agentIDs(args.agent_ids);
  if (!ids.length) throw new Error('Choose at least one agent');
  for (const aid of ids) await requireAgentAccess(aid);
  if (!(await getUser(OPERATOR)))
    await createUser({
      id: OPERATOR,
      kind: 'human',
      display_name: 'Local operator',
      created_at: new Date().toISOString(),
    });
  return getDb().transaction(async () => {
    const existing = await getDb().get<DesktopRoom>('SELECT * FROM desktop_rooms WHERE id = ?', id);
    if (existing) {
      if (
        existing.name !== name ||
        existing.purpose !== purpose ||
        JSON.stringify((await members(id)).map((m) => m.agent_id)) !== JSON.stringify(ids)
      ) {
        throw new Error('This room ID already belongs to a different request');
      }
      return snapshot(id);
    }
    const now = new Date().toISOString();
    await getDb().run(
      'INSERT INTO desktop_rooms (id, name, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      name,
      purpose,
      now,
      now,
    );
    for (const aid of ids) await addMember(id, aid);
    return snapshot(id);
  });
}
export async function updateRoom(args: Record<string, unknown>) {
  const id = uuid(args.id, 'id');
  const ids = args.agent_ids === undefined ? undefined : agentIDs(args.agent_ids);
  if (ids && !ids.length) throw new Error('Keep at least one agent in the room');
  if (ids) for (const aid of ids) await requireAgentAccess(aid);
  return getDb().transaction(async () => {
    const r = await room(id);
    if (args.revision !== r.revision) throw new Error('Room changed elsewhere. Reload before saving.');
    const name = args.name === undefined ? r.name : boundedText(args.name, 'name', 80, true).trim();
    const purpose = args.purpose === undefined ? r.purpose : boundedText(args.purpose, 'purpose', 2000);
    const notes = args.notes === undefined ? r.notes : boundedText(args.notes, 'notes', 50000);
    if (ids) {
      for (const m of await members(id))
        if (!ids.includes(m.agent_id)) {
          for (const w of await getMessagingGroupAgents(m.messaging_group_id)) await deleteMessagingGroupAgent(w.id);
          await getDb().run(
            'UPDATE desktop_room_agents SET active = 0 WHERE room_id = ? AND agent_id = ?',
            id,
            m.agent_id,
          );
        }
      for (const aid of ids) await addMember(id, aid);
    }
    await getDb().run(
      'UPDATE desktop_rooms SET name = ?, purpose = ?, notes = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      name,
      purpose,
      notes,
      new Date().toISOString(),
      id,
    );
    return snapshot(id);
  });
}
export async function validThread(id: string, value: unknown): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 300) throw new Error('Invalid thread');
  const m = await getDb().get<RoomMessage>(
    'SELECT * FROM desktop_room_messages WHERE id = ? AND room_id = ?',
    value,
    id,
  );
  if (!m || m.thread_id) throw new Error('Thread root must be a top-level message in this room');
  return m.id;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Must be called within the transaction that inserts the canonical event. */
export async function enqueue(
  message: RoomMessage | Omit<RoomMessage, 'seq'>,
  recipients: RoomAgent[],
  targets: string[],
): Promise<void> {
  for (const m of recipients) {
    if (message.author_kind === 'agent' && m.agent_id === message.author_id) continue;
    await getDb().run(
      `INSERT INTO desktop_room_outbox (message_id, agent_id, targeted) VALUES (?, ?, ?)
      ON CONFLICT(message_id, agent_id) DO NOTHING`,
      message.id,
      m.agent_id,
      targets.includes(m.agent_id) ? 1 : 0,
    );
  }
}
export async function insertMessage(m: Omit<RoomMessage, 'seq'>): Promise<void> {
  await getDb().run(
    `INSERT INTO desktop_room_messages
    (id,room_id,thread_id,author_id,author_kind,author_name,text,targets,fingerprint,created_at)
    VALUES (@id,@room_id,@thread_id,@author_id,@author_kind,@author_name,@text,@targets,@fingerprint,@created_at)`,
    m,
  );
}
