import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { routeInbound } from '../../router.js';
import type { OutboundMessage, DeliverySource } from '../../channels/adapter.js';
import { log } from '../../log.js';
import {
  CHANNEL,
  OPERATOR,
  address,
  uuid,
  boundedText,
  agentIDs,
  room,
  members,
  validateMember,
  validThread,
  fingerprint,
  enqueue,
  insertMessage,
} from './store.js';
import type { RoomAgent, RoomDelivery, RoomMessage } from './types.js';

let draining: Promise<void> | undefined;
let stopped = false;
const typing = new Map<string, { agent_id: string; thread_id: string | null; until: number }>();
export function setRoomTyping(platformID: string, threadID: string | null): void {
  const split = platformID.indexOf('/');
  if (split < 0) return;
  typing.set(platformID, { agent_id: platformID.slice(split + 1), thread_id: threadID, until: Date.now() + 12000 });
}
export function stopRoomQueue() {
  stopped = true;
  typing.clear();
}
export function startRoomQueue() {
  stopped = false;
}

export async function sendRoom(args: Record<string, unknown>) {
  const roomID = uuid(args.id, 'id'),
    clientID = uuid(args.client_id, 'client_id');
  const text = boundedText(args.text, 'text', 64000, true);
  const targets = agentIDs(args.target_agent_ids ?? []);
  await room(roomID);
  const threadID = await validThread(roomID, args.thread_id),
    recipients = await members(roomID);
  if (targets.some((id) => !recipients.some((m) => m.agent_id === id)))
    throw new Error('Target is not a current participant');
  for (const m of recipients) await validateMember(m);
  const id = `human:${clientID}`,
    stamp = fingerprint([roomID, threadID, text, targets]);
  const result = await getDb().transaction(async () => {
    const existing = await getDb().get<RoomMessage>('SELECT * FROM desktop_room_messages WHERE id = ?', id);
    if (existing) {
      if (existing.fingerprint !== stamp) throw new Error('client_id was already used for a different message');
      return { id: existing.id, seq: existing.seq, accepted: true, duplicate: true };
    }
    const message = {
      id,
      room_id: roomID,
      thread_id: threadID,
      author_id: OPERATOR,
      author_kind: 'human' as const,
      author_name: 'You',
      text,
      targets: JSON.stringify(targets),
      fingerprint: stamp,
      created_at: new Date().toISOString(),
    };
    await insertMessage(message);
    await enqueue(message, recipients, targets);
    const saved = await getDb().get<RoomMessage>('SELECT * FROM desktop_room_messages WHERE id = ?', id);
    return { id, seq: saved!.seq, accepted: true, duplicate: false };
  });
  // Accepted means durable. Routing and execution are separate and observable.
  void flushRoomQueue().catch((err) => log.error('Desktop room queue failed', { err }));
  return result;
}

/** Called only by the trusted host delivery bridge, never with provenance from content. */
export async function deliverRoom(
  platformID: string,
  threadID: string | null,
  message: OutboundMessage,
): Promise<string> {
  const source: DeliverySource | undefined = message.source;
  if (!source || !source.messageId || !source.sessionId || !source.agentGroupId)
    throw new Error('Desktop delivery requires host provenance');
  const mapping = await getDb().get<RoomAgent>(
    `SELECT * FROM desktop_room_agents WHERE agent_id = ? AND active = 1
    AND room_id || '/' || agent_id = ?`,
    source.agentGroupId,
    platformID,
  );
  if (!mapping) throw new Error('Desktop delivery participant is no longer in this room');
  await validateMember(mapping);
  const session = await getSession(source.sessionId);
  if (!session || session.agent_group_id !== source.agentGroupId)
    throw new Error('Desktop delivery source does not match its session');
  // Intentional cross-room sends are permitted only through the sender's own authorized destination.
  // The core delivery path has already checked destination access; this mapping validates identity.
  await validThread(mapping.room_id, threadID);
  if (message.files?.length || !['chat', 'chat-sdk'].includes(message.kind)) {
    throw new Error('Desktop rooms do not yet support files or interactive output; delivery remains unacknowledged');
  }
  const content = message.content as Record<string, unknown> | null;
  if (!content || typeof content !== 'object') throw new Error('Desktop message content is invalid');
  if (
    content.questionId ||
    content.question_id ||
    content.options ||
    content.actions ||
    content.attachments ||
    content.files
  ) {
    throw new Error('Desktop rooms cannot acknowledge interactive content or attachments');
  }
  const text = boundedText(
    typeof content.text === 'string' ? content.text : typeof content.title === 'string' ? content.title : '',
    'reply text',
    128000,
    true,
  );
  if (source.messageId.length > 300 || source.sessionId.length > 160) throw new Error('Invalid delivery identity');
  const id = `agent:${source.sessionId}:${source.messageId}`;
  const stamp = fingerprint([mapping.room_id, threadID, source.agentGroupId, text]);
  const author = await getAgentGroup(source.agentGroupId);
  const recipients = await members(mapping.room_id);
  await getDb().transaction(async () => {
    const existing = await getDb().get<RoomMessage>('SELECT * FROM desktop_room_messages WHERE id = ?', id);
    if (existing) {
      if (existing.fingerprint !== stamp) throw new Error('Desktop delivery ID conflicts with an existing event');
      return;
    }
    const event = {
      id,
      room_id: mapping.room_id,
      thread_id: threadID,
      author_id: source.agentGroupId,
      author_kind: 'agent' as const,
      author_name: author?.name ?? 'Agent',
      text,
      targets: '[]',
      fingerprint: stamp,
      created_at: source.timestamp,
    };
    await insertMessage(event);
    await enqueue(event, recipients, []);
  });
  typing.delete(platformID);
  void flushRoomQueue().catch((err) => log.error('Desktop peer queue failed', { err }));
  return id;
}

/** Finite batch, stable routing IDs, and persisted per-recipient acknowledgements. */
export function flushRoomQueue(): Promise<void> {
  if (draining) return draining;
  draining = drain().finally(() => {
    draining = undefined;
  });
  return draining;
}
async function drain(): Promise<void> {
  if (stopped) return;
  const rows = await getDb().all<RoomDelivery>(`SELECT o.* FROM desktop_room_outbox o
    JOIN desktop_room_messages m ON m.id = o.message_id
    WHERE o.state = 'pending' AND o.attempts < 5 ORDER BY m.seq, o.targeted, o.agent_id LIMIT 64`);
  for (const item of rows) {
    if (stopped) return;
    const event = await getDb().get<RoomMessage>('SELECT * FROM desktop_room_messages WHERE id = ?', item.message_id);
    if (!event) continue;
    const recipient = (await members(event.room_id)).find((m) => m.agent_id === item.agent_id);
    try {
      if (!recipient) throw new Error('Participant removed before delivery');
      // Silent context is subject to the same access checks as a targeted send.
      await validateMember(recipient);
    } catch (err) {
      await getDb().run(
        "UPDATE desktop_room_outbox SET state = 'blocked', error = ? WHERE message_id = ? AND agent_id = ?",
        err instanceof Error ? err.message : 'Participant access changed',
        item.message_id,
        item.agent_id,
      );
      continue;
    }
    try {
      const r = await room(event.room_id);
      const context = item.targeted
        ? `[Shared room: ${r.name}]\nPurpose: ${r.purpose}\nShared notes: ${r.notes}\n` +
          'You were explicitly addressed. Other participants receive your reply as quiet context; do not request a reply loop.\n\n'
        : '';
      // Claim durably before crossing into session-local mailbox state. An interrupted
      // claim is uncertain, never replayed automatically into a different session.
      await getDb().run(
        "UPDATE desktop_room_outbox SET state = 'routing' WHERE message_id = ? AND agent_id = ?",
        item.message_id,
        item.agent_id,
      );
      await routeInbound({
        channelType: CHANNEL,
        instance: CHANNEL,
        platformId: address(event.room_id, item.agent_id),
        threadId: event.thread_id,
        message: {
          id: event.id,
          kind: 'chat',
          timestamp: event.created_at,
          isMention: item.targeted === 1,
          isGroup: true,
          content: JSON.stringify({
            text: context + event.text,
            sender: event.author_name,
            senderId: event.author_kind === 'human' ? OPERATOR : `agent:${event.author_id}`,
            authorKind: event.author_kind,
            roomMessageId: event.id,
          }),
        },
      });
      await getDb().run(
        "UPDATE desktop_room_outbox SET state = 'routed', error = NULL WHERE message_id = ? AND agent_id = ?",
        item.message_id,
        item.agent_id,
      );
    } catch (err) {
      await getDb().run(
        `UPDATE desktop_room_outbox SET attempts = attempts + 1,
        state = CASE WHEN state = 'routing' THEN 'uncertain' WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END, error = ? WHERE message_id = ? AND agent_id = ?`,
        err instanceof Error ? err.message.slice(0, 500) : 'Routing failed',
        item.message_id,
        item.agent_id,
      );
    }
  }
}
export async function history(args: Record<string, unknown>) {
  const id = uuid(args.id, 'id');
  await room(id);
  const limit = Math.min(20, Math.max(1, Number.isSafeInteger(args.limit) ? Number(args.limit) : 20));
  const after = args.after,
    before = args.before;
  if (after !== undefined && before !== undefined) throw new Error('Use after or before, not both');
  for (const v of [after, before])
    if (v !== undefined && (!Number.isSafeInteger(v) || Number(v) < 0)) throw new Error('Invalid history cursor');
  let rows: RoomMessage[];
  if (after !== undefined)
    rows = await getDb().all(
      'SELECT * FROM desktop_room_messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      id,
      after,
      limit,
    );
  else if (before !== undefined)
    rows = (
      await getDb().all<RoomMessage>(
        'SELECT * FROM desktop_room_messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
        id,
        before,
        limit,
      )
    ).reverse();
  else
    rows = (
      await getDb().all<RoomMessage>(
        'SELECT * FROM desktop_room_messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?',
        id,
        limit,
      )
    ).reverse();
  const events = [];
  for (const row of rows) {
    const deliveries = await getDb().all<RoomDelivery>(
      'SELECT * FROM desktop_room_outbox WHERE message_id = ? ORDER BY agent_id',
      row.id,
    );
    events.push({ ...row, fingerprint: undefined, targets: JSON.parse(row.targets), deliveries });
  }
  const latest = await getDb().get<{ seq: number }>(
    'SELECT MAX(seq) AS seq FROM desktop_room_messages WHERE room_id = ?',
    id,
  );
  const now = Date.now();
  for (const [key, value] of typing) if (value.until < now) typing.delete(key);
  return {
    events,
    cursor: rows.at(-1)?.seq ?? Number(after ?? 0),
    latest_cursor: latest?.seq ?? 0,
    typing: [...typing.entries()].filter(([key]) => key.startsWith(id + '/')).map(([, v]) => v),
  };
}
export async function retry(args: Record<string, unknown>) {
  const id = uuid(args.id, 'id');
  await room(id);
  const event = await getDb().get<RoomMessage>(
    'SELECT * FROM desktop_room_messages WHERE id = ? AND room_id = ?',
    args.message_id,
    id,
  );
  if (!event) throw new Error('Room message not found');
  for (const m of await members(id)) await validateMember(m);
  await getDb().run(
    "UPDATE desktop_room_outbox SET state = 'pending', attempts = 0, error = NULL WHERE message_id = ? AND state IN ('failed','blocked')",
    event.id,
  );
  void flushRoomQueue().catch((err) => log.error('Desktop retry failed', { err }));
  return { accepted: true, id: event.id };
}

/** Receipt-only refresh keeps older unresolved messages current without replaying text. */
export async function receipts(args: Record<string, unknown>) {
  const id = uuid(args.id, 'id');
  await room(id);
  const ids = args.message_ids;
  if (!Array.isArray(ids) || ids.length > 200 || ids.some((v) => typeof v !== 'string' || v.length > 500))
    throw new Error('Use up to 200 message IDs');
  const result = [];
  for (const messageID of [...new Set(ids as string[])]) {
    if (!(await getDb().get('SELECT id FROM desktop_room_messages WHERE id = ? AND room_id = ?', messageID, id)))
      continue;
    result.push({
      id: messageID,
      deliveries: await getDb().all<RoomDelivery>(
        'SELECT * FROM desktop_room_outbox WHERE message_id = ? ORDER BY agent_id',
        messageID,
      ),
    });
  }
  return result;
}
