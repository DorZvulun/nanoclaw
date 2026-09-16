/** Opt-in: fresh agents and containers against a credential-free local model. */
import fs from 'fs';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { describe, it, expect, vi } from 'vitest';
const testPaths = vi.hoisted(() => ({
  root: `/tmp/ncl-room-e2e-${process.pid}`,
  slug: `desktop-room-e2e-${process.pid}`,
}));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: testPaths.root + '/data',
    GROUPS_DIR: testPaths.root + '/groups',
    STORE_DIR: testPaths.root + '/store',
    INSTALL_SLUG: testPaths.slug,
    CONTAINER_INSTALL_LABEL: `nanoclaw-install=${testPaths.slug}`,
    ONECLI_URL: undefined,
    ONECLI_API_KEY: undefined,
    EGRESS_LOCKDOWN: false,
  };
});
import '../index.js';
import '../../channels/index.js';
import '../../providers/index.js';
import '../../cli/commands/index.js';
import { resetGatewayProvider } from '../../gateway-providers/index.js';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getActiveSessions } from '../../db/sessions.js';
import { createUser } from '../permissions/db/users.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from '../../channels/channel-registry.js';
import { setDeliveryAdapter, startActiveDeliveryPoll, stopDeliveryPolls } from '../../delivery.js';
import { startCliServer, stopCliServer } from '../../cli/socket-server.js';
import { dispatch } from '../../cli/dispatch.js';
import { startRoomQueue, stopRoomQueue, flushRoomQueue } from './runtime.js';

const enabled = process.env.NANOCLAW_DESKTOP_ROOM_E2E === '1';
describe.skipIf(!enabled)('desktop room isolated local inference', () => {
  it('gets real replies from two fresh agents without waking quiet peers', async () => {
    if (
      !process.env.OPENCODE_MODEL ||
      new URL(process.env.ANTHROPIC_BASE_URL ?? 'http://invalid').hostname !== 'host.docker.internal' ||
      !process.env.NANOCLAW_DESKTOP_ROOM_IMAGE
    )
      throw new Error('This test requires the explicitly selected local model endpoint');
    const roomID = randomUUID();
    async function call(verb: string, args: Record<string, unknown> = {}) {
      const r = await dispatch({ id: randomUUID(), command: `desktop-rooms-${verb}`, args }, { caller: 'host' });
      if (!r.ok) throw new Error(r.error.message);
      return r.data as any;
    }
    fs.mkdirSync(testPaths.root + '/data', { recursive: true });
    await runMigrations(await initTestDb());
    // Stub only the external credential gateway; the local model requires no credentials.
    resetGatewayProvider({ kind: 'synthetic-local-no-credentials', contribute: async () => ({}) });
    try {
      await createUser({
        id: 'cli:local',
        kind: 'human',
        display_name: 'Synthetic operator',
        created_at: new Date().toISOString(),
      });
      for (const id of ['room-e2e-a', 'room-e2e-b']) {
        fs.mkdirSync(`${testPaths.root}/groups/${id}`, { recursive: true });
        fs.writeFileSync(
          `${testPaths.root}/groups/${id}/CLAUDE.md`,
          'This is a synthetic integration test. Reply briefly to explicit questions. Never call tools or contact external services.',
        );
        await createAgentGroup({
          id,
          name: id,
          folder: id,
          agent_provider: 'opencode',
          created_at: new Date().toISOString(),
        });
        await ensureContainerConfig(id, 'opencode');
        await updateContainerConfigScalars(id, {
          provider: 'opencode',
          model: process.env.OPENCODE_MODEL,
          image_tag: process.env.NANOCLAW_DESKTOP_ROOM_IMAGE,
          cli_scope: 'disabled',
          max_messages_per_prompt: 10,
        });
        await addMember({
          user_id: 'cli:local',
          agent_group_id: id,
          added_by: 'cli:local',
          added_at: new Date().toISOString(),
        });
      }
      await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
      await startCliServer(testPaths.root + '/data/ncl.sock');
      setDeliveryAdapter(createChannelDeliveryAdapter());
      startActiveDeliveryPoll();
      startRoomQueue();
      await call('create', {
        id: roomID,
        name: 'Isolated room verification',
        purpose: 'Synthetic local-model test',
        agent_ids: ['room-e2e-a', 'room-e2e-b'],
      });
      await call('send', {
        id: roomID,
        client_id: randomUUID(),
        text: 'Reply with exactly: ROOM_ALPHA_VERIFIED. Do not call tools.',
        target_agent_ids: ['room-e2e-a'],
      });
      let first: any[] = [];
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        await flushRoomQueue();
        first = (await call('history', { id: roomID })).events;
        if (first.some((e) => e.author_kind === 'agent')) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(first.some((e) => e.author_id === 'room-e2e-a' && e.text.includes('ROOM_ALPHA_VERIFIED'))).toBe(true);
      expect(first.some((e) => e.author_id === 'room-e2e-b')).toBe(false);
      const quiet = (await getActiveSessions()).find((s) => s.agent_group_id === 'room-e2e-b');
      expect(quiet?.container_status).not.toBe('running');
      await call('send', {
        id: roomID,
        client_id: randomUUID(),
        text: 'What exact verification phrase did the other agent just post? Reply with that phrase only. Do not call tools.',
        target_agent_ids: ['room-e2e-b'],
      });
      let second: any[] = [];
      const secondDeadline = Date.now() + 150000;
      while (Date.now() < secondDeadline) {
        await flushRoomQueue();
        second = (await call('history', { id: roomID })).events;
        if (second.some((e) => e.author_id === 'room-e2e-b')) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(second.some((e) => e.author_id === 'room-e2e-b' && e.text.includes('ROOM_ALPHA_VERIFIED'))).toBe(true);
      fs.writeFileSync(
        testPaths.root + '/result.json',
        JSON.stringify(
          {
            passed: true,
            events: second.map((e) => ({ id: e.id, author: e.author_id, text: e.text })),
            model: process.env.OPENCODE_MODEL,
          },
          null,
          2,
        ),
      );
    } finally {
      stopRoomQueue();
      await flushRoomQueue();
      stopDeliveryPolls();
      await stopCliServer();
      await teardownChannelAdapters();
      // Exact task-created container label only. Never touches a pre-existing installation.
      const ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=nanoclaw-install=${testPaths.slug}`], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'pipe' });
      for (let tick = 0; tick < 30; tick++) {
        if ((await getActiveSessions()).every((s) => s.container_status === 'stopped')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await closeDb();
      // Preserve this isolated run's evidence for the task report. No user data is present.
    }
  }, 330000);
});
