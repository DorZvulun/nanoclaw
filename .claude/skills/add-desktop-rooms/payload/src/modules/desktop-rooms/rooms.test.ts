import Database from 'better-sqlite3';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: `/tmp/nanoclaw-desktop-rooms-tests-${process.pid}` }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: paths.root + '/data',
    GROUPS_DIR: paths.root + '/groups',
    DEFAULT_MODEL: 'test-install-default',
  };
});
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(false) }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// The real barrel, migrations, registries, router, permissions and mailbox are under test.
import '../index.js';
import '../../cli/commands/index.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup, updateAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { createSession, getActiveSessions } from '../../db/sessions.js';
import { createUser } from '../permissions/db/users.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  getRegisteredChannelNames,
  createChannelDeliveryAdapter,
} from '../../channels/channel-registry.js';
import { dispatch } from '../../cli/dispatch.js';
import { lookup } from '../../cli/registry.js';
import { requestWake } from '../../request-wake.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { managementCatalog } from './catalog.js';
import { deleteMessagingGroup } from '../../db/messaging-groups.js';
import { startRoomQueue, stopRoomQueue, flushRoomQueue } from './runtime.js';

let roomID: string;
async function call(verb: string, args: Record<string, unknown> = {}) {
  const result = await dispatch({ id: randomUUID(), command: 'desktop-rooms-' + verb, args }, { caller: 'host' });
  if (!result.ok) throw new Error(result.error.message);
  return result.data as any;
}
const send = (text = 'A question', target_agent_ids = ['agent-a'], client_id = randomUUID(), extra = {}) =>
  call('send', { id: roomID, client_id, text, target_agent_ids, ...extra });
async function runQueue() {
  startRoomQueue();
  await flushRoomQueue();
  stopRoomQueue();
}
async function makeReply(
  agentID = 'agent-a',
  text = 'A useful reply',
  messageID = 'reply-1',
  threadID: string | null = null,
) {
  const member = await getDb().get<{ messaging_group_id: string }>(
    'SELECT messaging_group_id FROM desktop_room_agents WHERE room_id = ? AND agent_id = ?',
    roomID,
    agentID,
  );
  const id = `reply-session-${agentID}`;
  const existing = await getDb().get('SELECT id FROM sessions WHERE id = ?', id);
  if (!existing)
    await createSession({
      id,
      agent_group_id: agentID,
      messaging_group_id: member!.messaging_group_id,
      thread_id: null,
      agent_provider: null,
      status: 'closed',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
  return createChannelDeliveryAdapter().deliver(
    'desktop',
    `${roomID}/${agentID}`,
    threadID,
    'chat',
    JSON.stringify({ text }),
    undefined,
    'desktop',
    {
      messageId: messageID,
      sessionId: id,
      agentGroupId: agentID,
      timestamp: new Date().toISOString(),
    },
  );
}
beforeEach(async () => {
  stopRoomQueue();
  await flushRoomQueue();
  fs.mkdirSync(paths.root, { recursive: true });
  await runMigrations(await initTestDb());
  for (const id of ['agent-a', 'agent-b', 'agent-c']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    fs.mkdirSync(path.join(paths.root, 'groups', id), { recursive: true });
  }
  await createUser({
    id: 'cli:local',
    kind: 'human',
    display_name: 'Existing name',
    created_at: new Date().toISOString(),
  });
  for (const id of ['agent-a', 'agent-b'])
    await addMember({
      user_id: 'cli:local',
      agent_group_id: id,
      added_by: 'cli:local',
      added_at: new Date().toISOString(),
    });
  await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
  roomID = randomUUID();
  await call('create', {
    id: roomID,
    name: 'Design room',
    purpose: 'Work together',
    agent_ids: ['agent-a', 'agent-b'],
  });
  vi.mocked(requestWake).mockClear();
});
afterEach(async () => {
  stopRoomQueue();
  await flushRoomQueue();
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

describe('optional desktop room module', () => {
  it.each([`ag-${randomUUID()}`, 'ag-1788360000000-abc123', randomUUID(), 'custom-agent-key'])(
    'loads and clears composer settings through real dispatch for existing opaque agent ID %s',
    async (agentID) => {
      await createAgentGroup({
        id: agentID,
        name: 'Composer default test',
        folder: agentID,
        agent_provider: null,
        created_at: new Date().toISOString(),
      });
      await ensureContainerConfig(agentID, 'claude');
      const command = (name: string, args: Record<string, unknown>) =>
        dispatch({ id: randomUUID(), command: name, args: { id: agentID, ...args } }, { caller: 'host' });
      const configured = await command('groups-config-update', { model: 'opus', effort: 'high' });
      expect(configured).toMatchObject({ ok: true, data: { model: 'opus', effort: 'high' } });
      const cleared = await command('groups-config-update', { model: null, effort: null });
      expect(cleared).toMatchObject({ ok: true, data: { model: null, effort: null } });
      expect(await getContainerConfig(agentID)).toMatchObject({ model: null, effort: null });
      expect(await command('groups-config-get', {})).toMatchObject({ ok: true, data: { model: null, effort: null } });
      expect(await command('desktop-model-options', {})).toMatchObject({
        ok: true,
        data: {
          provider: 'claude',
          model: '',
          effort: '',
          effective_model: 'test-install-default',
          can_configure_effort: true,
        },
      });
    },
  );
  it('registers through the real module barrel and applies its migration', async () => {
    expect(getRegisteredChannelNames()).toContain('desktop');
    expect(lookup('desktop-rooms-send')?.hostOnly).toBe(true);
    expect((await call('capabilities')).version).toBe(1);
    expect(await getDb().hasTable('desktop_room_messages')).toBe(true);
    expect(
      (await getDb().get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', 'cli:local'))
        ?.display_name,
    ).toBe('Existing name');
  });
  it('rejects all container callers even when they have global CLI scope', async () => {
    const r = await dispatch(
      { id: 'x', command: 'desktop-rooms-list', args: {} },
      { caller: 'agent', sessionId: 'x', agentGroupId: 'agent-a', messagingGroupId: 'x' },
    );
    expect(r.ok).toBe(false);
  });
  it('creates idempotently without touching existing routes', async () => {
    const result = await call('create', {
      id: roomID,
      name: 'Design room',
      purpose: 'Work together',
      agent_ids: ['agent-b', 'agent-a'],
    });
    expect(result.id).toBe(roomID);
    expect(await getDb().all('SELECT * FROM desktop_rooms')).toHaveLength(1);
    expect(await getDb().all('SELECT * FROM messaging_groups')).toHaveLength(2);
  });
  it('does not grant access by joining a room', async () => {
    await expect(call('create', { id: randomUUID(), name: 'No access', agent_ids: ['agent-c'] })).rejects.toThrow(
      'existing access',
    );
  });
  it('atomically accepts one canonical event, two receipts, and rejects conflicting client retries', async () => {
    const id = randomUUID();
    const [a, b] = await Promise.all([send('Same', ['agent-a'], id), send('Same', ['agent-a'], id)]);
    expect(a.id).toBe(b.id);
    expect(await getDb().all('SELECT * FROM desktop_room_messages')).toHaveLength(1);
    expect(await getDb().all('SELECT * FROM desktop_room_outbox')).toHaveLength(2);
    await expect(send('Different', ['agent-a'], id)).rejects.toThrow('different message');
  });
  it('retains repeated identical text with different IDs', async () => {
    await send('Repeat');
    await send('Repeat');
    expect((await call('history', { id: roomID })).events).toHaveLength(2);
  });
  it('routes context to both real sessions but wakes only the targeted agent', async () => {
    await send();
    await runQueue();
    expect(vi.mocked(requestWake).mock.calls).toHaveLength(1);
    expect(vi.mocked(requestWake).mock.calls[0][0].agent_group_id).toBe('agent-a');
    const sessions = await getActiveSessions();
    expect(sessions.filter((s) => ['agent-a', 'agent-b'].includes(s.agent_group_id))).toHaveLength(2);
    for (const s of sessions) {
      const rows = await withExistingMailboxSession(s.agent_group_id, s.id, (m) => m.getInboundHistory(10));
      expect(rows?.some((r) => r.content.includes('A question'))).toBe(true);
    }
  });
  it('keeps a room-only post durable without waking either agent', async () => {
    await send('For everyone', []);
    await runQueue();
    expect(requestWake).not.toHaveBeenCalled();
    expect((await call('history', { id: roomID })).events[0].text).toBe('For everyone');
  });
  it('blocks silent delivery after membership access is revoked', async () => {
    await send();
    await getDb().run(
      'DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?',
      'cli:local',
      'agent-b',
    );
    await runQueue();
    const receipt = await getDb().get<{ state: string }>(
      'SELECT state FROM desktop_room_outbox WHERE agent_id = ?',
      'agent-b',
    );
    expect(receipt?.state).toBe('blocked');
    expect((await getActiveSessions()).some((s) => s.agent_group_id === 'agent-b')).toBe(false);
  });
  it('rejects nonparticipants, foreign thread roots, and reserved thread IDs', async () => {
    await expect(send('bad', ['agent-c'])).rejects.toThrow('not a current participant');
    await expect(send('bad', ['agent-a'], randomUUID(), { thread_id: 'system:tasks' })).rejects.toThrow('Thread root');
    const second = randomUUID();
    await call('create', { id: second, name: 'Other', agent_ids: ['agent-a'] });
    const event = await send();
    await expect(
      call('send', { id: second, client_id: randomUUID(), text: 'bad', thread_id: event.id }),
    ).rejects.toThrow('Thread root');
  });
  it('supports thread roots and optimistic note editing', async () => {
    const parent = await send('Root', []);
    await send('Reply', ['agent-b'], randomUUID(), { thread_id: parent.id });
    const edited = await call('update', { id: roomID, revision: 1, notes: 'Shared decision' });
    expect(edited.revision).toBe(2);
    await expect(call('update', { id: roomID, revision: 1, notes: 'stale' })).rejects.toThrow('changed elsewhere');
  });
  it('uses trusted host author IDs and makes outbound retries idempotent', async () => {
    const id = await makeReply();
    await makeReply();
    const events = (await call('history', { id: roomID })).events;
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
    expect(events[0].author_id).toBe('agent-a');
    await updateAgentGroup('agent-a', { name: 'New name' });
    expect((await call('history', { id: roomID })).events[0].author_id).toBe('agent-a');
    await runQueue();
    expect(requestWake).not.toHaveBeenCalled();
    const receiver = (await getActiveSessions()).find((s) => s.agent_group_id === 'agent-b')!;
    const inbound = await withExistingMailboxSession('agent-b', receiver.id, (m) => m.getInboundHistory(10));
    expect(inbound?.some((r) => r.content.includes('agent:agent-a'))).toBe(true);
  });
  it('rejects missing or mismatched host provenance even if content claims it', async () => {
    await expect(
      createChannelDeliveryAdapter().deliver(
        'desktop',
        `${roomID}/agent-a`,
        null,
        'chat',
        JSON.stringify({ text: 'fake', source: { agentGroupId: 'agent-a' } }),
      ),
    ).rejects.toThrow('host provenance');
    await expect(
      createChannelDeliveryAdapter().deliver(
        'desktop',
        `${roomID}/agent-b`,
        null,
        'chat',
        JSON.stringify({ text: 'fake' }),
        undefined,
        'desktop',
        {
          messageId: 'x',
          sessionId: 'missing',
          agentGroupId: 'agent-a',
          timestamp: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow('participant');
  });
  it('paginates by stable sequence and excludes other rooms', async () => {
    await send('first', []);
    await send('second', []);
    await send('third', []);
    const first = await call('history', { id: roomID, after: 0, limit: 2 });
    expect(first.events.map((e: any) => e.text)).toEqual(['first', 'second']);
    const next = await call('history', { id: roomID, after: first.cursor });
    expect(next.events.map((e: any) => e.text)).toEqual(['third']);
  });
  it('does not prevent existing agent and channel deletion and preserves room history', async () => {
    await send('Preserve this', []);
    const route = await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM desktop_room_agents WHERE agent_id = ?',
      'agent-a',
    );
    await call('update', { id: roomID, revision: 1, agent_ids: ['agent-b'] });
    await deleteMessagingGroup(route!.messaging_group_id);
    expect(await getDb().all('SELECT * FROM desktop_room_agents WHERE agent_id = ?', 'agent-a')).toHaveLength(0);
    const deleted = await dispatch(
      { id: 'delete-test', command: 'groups-delete', args: { id: 'agent-b' } },
      { caller: 'host' },
    );
    expect(deleted.ok).toBe(true);
    expect(await getDb().all('SELECT * FROM desktop_room_agents')).toHaveLength(0);
    expect((await call('history', { id: roomID })).events[0].text).toBe('Preserve this');
  });
  it('never replays an interrupted routing claim into a new session', async () => {
    await send();
    await getDb().run("UPDATE desktop_room_outbox SET state = 'routing' WHERE agent_id = 'agent-a'");
    await runQueue();
    expect(requestWake).not.toHaveBeenCalled();
    expect((await getActiveSessions()).some((s) => s.agent_group_id === 'agent-a')).toBe(false);
    const event = (await call('history', { id: roomID })).events[0];
    await call('retry', { id: roomID, message_id: event.id });
    await runQueue();
    expect(requestWake).not.toHaveBeenCalled();
  });
  it('rejects declared attachments and questions without acknowledging text-only delivery', async () => {
    await makeReply();
    const source = {
      messageId: 'unsupported',
      sessionId: 'reply-session-agent-a',
      agentGroupId: 'agent-a',
      timestamp: new Date().toISOString(),
    };
    for (const content of [
      { text: 'has file', files: ['missing.txt'] },
      { text: 'question', question_id: 'q', options: ['Yes'] },
    ]) {
      await expect(
        createChannelDeliveryAdapter().deliver(
          'desktop',
          `${roomID}/agent-a`,
          null,
          'chat',
          JSON.stringify(content),
          undefined,
          'desktop',
          source,
        ),
      ).rejects.toThrow('cannot acknowledge');
    }
    expect((await call('history', { id: roomID })).events).toHaveLength(1);
  });
  it('exposes complete native forms while preserving real read-only and argument contracts', async () => {
    const catalog = managementCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(13);
    expect(catalog.flatMap((r) => r.operations).filter((o) => !o.supported)).toEqual([]);
    expect(catalog.find((r) => r.id === 'approvals')?.operations.every((o) => o.effect === 'read')).toBe(true);
    expect(catalog.find((r) => r.id === 'tasks')?.operations.find((o) => o.verb === 'delete')?.effect).toBe(
      'destructive',
    );
    const mcp = catalog.find((r) => r.id === 'groups')?.operations.find((o) => o.verb === 'config add-mcp-server');
    expect(mcp?.fields.find((f) => f.name === 'env')?.type).toBe('string');
    const mount = catalog.find((r) => r.id === 'groups')?.operations.find((o) => o.verb === 'config remove-mount');
    expect(mount?.fields.every((f) => f.required)).toBe(true);
  });

  it('carries trusted provenance from the real outbound mailbox through core delivery', async () => {
    await send();
    await runQueue();
    const session = (await getActiveSessions()).find((s) => s.agent_group_id === 'agent-a')!;
    const db = new Database(outboundDbPath('agent-a', session.id));
    db.prepare(
      "INSERT INTO messages_out (id,timestamp,kind,platform_id,channel_type,content) VALUES (?,datetime('now'),'chat',?,'desktop',?)",
    ).run('real-host-reply', `${roomID}/agent-a`, JSON.stringify({ text: 'Delivered through the real host bridge' }));
    db.close();
    setDeliveryAdapter(createChannelDeliveryAdapter());
    await deliverSessionMessages(session);
    const reply = (await call('history', { id: roomID })).events.find(
      (e: any) => e.text === 'Delivered through the real host bridge',
    );
    expect(reply?.id).toBe(`agent:${session.id}:real-host-reply`);
    expect(reply?.author_id).toBe('agent-a');
    await deliverSessionMessages(session);
    expect((await call('history', { id: roomID })).events.filter((e: any) => e.id === reply.id)).toHaveLength(1);
  });
});
