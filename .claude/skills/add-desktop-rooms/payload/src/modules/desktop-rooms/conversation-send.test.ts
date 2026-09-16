import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: `/tmp/nanoclaw-desktop-attachment-tests-${process.pid}` }));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: paths.root + '/data',
  GROUPS_DIR: paths.root + '/groups',
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(false) }));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// Exercise the actual module barrel, router, permissions and inbox staging.
import '../index.js';
import '../../cli/commands/index.js';
import { dispatch } from '../../cli/dispatch.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../permissions/db/users.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { sessionDir, withExistingMailboxSession } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import { registerMessageInterceptor } from '../../router.js';

const agentID = 'ag-49d25cae-8ff2-4bda-913b-4bed13f1f03a';
let messagingGroupID: string;
let intercept = false;
registerMessageInterceptor(async (event) => intercept && event.channelType === 'cli');
async function command(name: string, args: Record<string, unknown> = {}) {
  const result = await dispatch({ id: randomUUID(), command: name, args }, { caller: 'host' });
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, unknown>;
}
const file = (name = 'notes.txt', text = 'A real attached file') => ({
  name,
  data: Buffer.from(text).toString('base64'),
  mimeType: 'text/plain',
});
const payload = (extra: Record<string, unknown> = {}) => ({
  agent_id: agentID,
  messaging_group_id: messagingGroupID,
  client_id: randomUUID(),
  text: 'Please read this',
  attachments: [file()],
  ...extra,
});
const send = (args = payload()) => command('desktop-conversation-send', args);
async function history() {
  const session = await findSessionForAgent(agentID, messagingGroupID, null);
  if (!session) return { session: undefined, rows: [] };
  const rows = await withExistingMailboxSession(agentID, session.id, (mailbox) => mailbox.getInboundHistory(200));
  return { session, rows: (rows ?? []).map((row) => JSON.parse(row.content) as Record<string, unknown>) };
}
beforeEach(async () => {
  intercept = false;
  vi.mocked(requestWake).mockClear();
  fs.mkdirSync(path.join(paths.root, 'groups', 'attachment-agent'), { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: agentID,
    name: 'Attachment test',
    folder: 'attachment-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createUser({
    id: 'cli:local',
    kind: 'human',
    display_name: 'Local operator',
    created_at: new Date().toISOString(),
  });
  await addMember({
    user_id: 'cli:local',
    agent_group_id: agentID,
    added_by: 'cli:local',
    added_at: new Date().toISOString(),
  });
  const group = await command('messaging-groups-create', {
    channel_type: 'cli',
    instance: 'cli',
    platform_id: `desktop-${agentID}`,
    name: 'Desktop attachment test',
    is_group: 0,
    unknown_sender_policy: 'strict',
  });
  messagingGroupID = String(group.id);
  await command('wirings-create', {
    messaging_group_id: messagingGroupID,
    agent_group_id: agentID,
    session_mode: 'shared',
    sender_scope: 'all',
    engage_mode: 'pattern',
    engage_pattern: '.',
  });
});
afterEach(async () => {
  intercept = false;
  await closeDb();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

describe('owner-only desktop direct attachments', () => {
  it('publishes honest limits and rejects every container caller', async () => {
    expect(await command('desktop-conversation-capabilities')).toEqual({
      attachments: true,
      max_files: 8,
      max_total_bytes: 2_097_152,
    });
    for (const name of ['desktop-conversation-capabilities', 'desktop-conversation-send']) {
      const result = await dispatch(
        { id: randomUUID(), command: name, args: payload() },
        { caller: 'agent', agentGroupId: agentID, sessionId: 'untrusted', messagingGroupId: messagingGroupID },
      );
      expect(result.ok).toBe(false);
    }
    expect(await getDb().all('SELECT * FROM desktop_conversation_sends')).toEqual([]);
  });
  it('stages actual file bytes in the selected agent inbox and strips base64 from history', async () => {
    const args = payload();
    expect(await send(args)).toMatchObject({
      accepted: true,
      state: 'accepted',
      duplicate: false,
      client_id: args.client_id,
    });
    const { session, rows } = await history();
    const content = rows.find((row) => row.desktopClientId === args.client_id)!;
    expect(content.senderId).toBe('cli:local');
    const saved = (content.attachments as Record<string, unknown>[])[0];
    expect(saved.data).toBeUndefined();
    expect(saved.name).toBe('notes.txt');
    expect(saved.size).toBe(Buffer.byteLength('A real attached file'));
    expect(fs.readFileSync(path.join(sessionDir(agentID, session!.id), String(saved.localPath)), 'utf8')).toBe(
      'A real attached file',
    );
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await getDb().all('SELECT * FROM desktop_conversation_sends'))).not.toContain(file().data);
  });
  it('accepts file-only and empty-file messages through the normal pattern route', async () => {
    const args = payload({ text: '', attachments: [file('empty.txt', '')] });
    expect(await send(args)).toMatchObject({ accepted: true });
    const { rows } = await history();
    expect(rows[0].text).toBe('');
    expect(requestWake).toHaveBeenCalledTimes(1);
  });
  it('preserves PNG bytes and image MIME metadata without claiming vision support', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1cAAAAASUVORK5CYII=',
      'base64',
    );
    const args = payload({
      text: '',
      attachments: [{ name: 'pixel.png', data: png.toString('base64'), mimeType: 'image/png' }],
    });
    expect(await send(args)).toMatchObject({ accepted: true });
    const { session, rows } = await history();
    const content = rows.find((row) => row.desktopClientId === args.client_id)!;
    const saved = (content.attachments as Record<string, unknown>[])[0];
    expect(saved.mimeType).toBe('image/png');
    expect(saved.data).toBeUndefined();
    expect(fs.readFileSync(path.join(sessionDir(agentID, session!.id), String(saved.localPath))).equals(png)).toBe(
      true,
    );
  });
  it('deduplicates identical retries durably and rejects reuse for a different payload', async () => {
    const args = payload();
    expect(await send(args)).toMatchObject({ accepted: true, duplicate: false });
    expect(await send(args)).toMatchObject({ accepted: true, duplicate: true });
    await expect(send({ ...args, attachments: [file('different.txt')] })).rejects.toThrow('different message');
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect((await history()).rows).toHaveLength(1);
  });
  it('claims concurrent sends once before routing', async () => {
    const args = payload();
    const results = await Promise.all([send(args), send(args)]);
    expect(results.filter((result) => result.duplicate === false)).toHaveLength(1);
    expect(requestWake).toHaveBeenCalledTimes(1);
    expect((await history()).rows).toHaveLength(1);
  });
  it('reports intercepted sends as uncertain and never replays their client ID', async () => {
    intercept = true;
    const args = payload();
    expect(await send(args)).toMatchObject({ accepted: false, state: 'uncertain', duplicate: false });
    intercept = false;
    expect(await send(args)).toMatchObject({ accepted: false, state: 'uncertain', duplicate: true });
    expect(requestWake).not.toHaveBeenCalled();
    expect((await history()).rows).toEqual([]);
  });
  it('does not replay a persisted interrupted routing claim', async () => {
    intercept = true;
    const args = payload();
    await send(args);
    await getDb().run("UPDATE desktop_conversation_sends SET state = 'routing' WHERE client_id = ?", args.client_id);
    intercept = false;
    expect(await send(args)).toMatchObject({ accepted: false, state: 'uncertain', duplicate: true });
    expect(requestWake).not.toHaveBeenCalled();
  });
  it('refuses to report success when the normal extractor rejects a symlink staging directory', async () => {
    await send(payload({ text: 'Establish session', attachments: [] }));
    const { session } = await history();
    const args = payload();
    const inbox = path.join(sessionDir(agentID, session!.id), 'inbox');
    const outside = path.join(paths.root, 'outside-inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(inbox, `desktop-${args.client_id}:${agentID}`));
    expect(await send(args)).toMatchObject({ accepted: false, state: 'uncertain' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it.each([
    { channel_type: 'telegram' },
    { instance: 'other' },
    { platform_id: 'someone-else' },
    { is_group: 1 },
    { denied_at: '2026-09-07T00:00:00Z' },
  ])('rejects an altered destination %j', async (fields) => {
    const [key, value] = Object.entries(fields)[0];
    await getDb().run(`UPDATE messaging_groups SET ${key} = ? WHERE id = ?`, value, messagingGroupID);
    await expect(send()).rejects.toThrow('routing changed');
    expect(await getDb().all('SELECT * FROM desktop_conversation_sends')).toEqual([]);
  });
  it('rejects conflicting wiring and access changes without granting access', async () => {
    await getDb().run(
      "UPDATE messaging_group_agents SET engage_pattern = 'hello' WHERE messaging_group_id = ?",
      messagingGroupID,
    );
    await expect(send()).rejects.toThrow('routing changed');
    await getDb().run(
      "UPDATE messaging_group_agents SET engage_pattern = '.' WHERE messaging_group_id = ?",
      messagingGroupID,
    );
    await getDb().run('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?', 'cli:local', agentID);
    await expect(send()).rejects.toThrow('existing access');
    // Only the exact selected route's public setting permits the local sender.
    await getDb().run("UPDATE messaging_groups SET unknown_sender_policy = 'public' WHERE id = ?", messagingGroupID);
    expect(await send()).toMatchObject({ accepted: true });
  });
  it.each([
    { text: '', attachments: [] },
    { attachments: [file('../escape.txt')] },
    { attachments: [file('line\nname')] },
    { attachments: [file('same.txt'), file('SAME.txt')] },
    { attachments: [{ name: 'bad.txt', data: 'not base64' }] },
    { attachments: [{ name: 'bad.txt', data: 'AB==' }] },
    { attachments: [{ ...file(), localPath: '/private/file' }] },
    { attachments: [{ ...file(), mimeType: 'text/plain\r\nHost: example' }] },
    { attachments: Array.from({ length: 9 }, (_, index) => file(`file-${index}`)) },
    { sender_id: 'someone-else' },
    { text: 'x'.repeat(64001) },
  ])('rejects invalid attachment or sender data case %# before accepting', async (fields) => {
    await expect(send(payload(fields))).rejects.toThrow();
    expect(await getDb().all('SELECT * FROM desktop_conversation_sends')).toEqual([]);
    expect(requestWake).not.toHaveBeenCalled();
  });
  it('enforces aggregate decoded bytes, including across files', async () => {
    const large = Buffer.alloc(1_048_577).toString('base64');
    await expect(
      send(
        payload({
          attachments: [
            { name: 'one.bin', data: large },
            { name: 'two.bin', data: large },
          ],
        }),
      ),
    ).rejects.toThrow('2 MiB');
    expect(await getDb().all('SELECT * FROM desktop_conversation_sends')).toEqual([]);
  });
});
