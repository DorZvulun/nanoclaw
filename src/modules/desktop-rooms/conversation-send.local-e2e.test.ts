/** Opt-in: one synthetic agent reads an attached file through real local inference. */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({
  root: `/tmp/ncl-attachment-e2e-${process.pid}`,
  slug: `desktop-attachment-e2e-${process.pid}`,
}));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: paths.root + '/data',
  GROUPS_DIR: paths.root + '/groups',
  STORE_DIR: paths.root + '/store',
  INSTALL_SLUG: paths.slug,
  CONTAINER_INSTALL_LABEL: `nanoclaw-install=${paths.slug}`,
  ONECLI_URL: undefined,
  ONECLI_API_KEY: undefined,
  EGRESS_LOCKDOWN: false,
}));
import '../index.js';
import '../../channels/index.js';
import '../../providers/index.js';
import '../../cli/commands/index.js';
import { resetGatewayProvider } from '../../gateway-providers/index.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getActiveSessions, findSessionForAgent } from '../../db/sessions.js';
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
import { sessionDir, withExistingMailboxSession } from '../../session-manager.js';

const enabled = process.env.NANOCLAW_DESKTOP_ATTACHMENT_E2E === '1';
describe.skipIf(!enabled)('desktop attachment isolated local inference', () => {
  it('reads a unique phrase available only inside the uploaded file and replies with it', async () => {
    const endpoint = new URL(process.env.ANTHROPIC_BASE_URL ?? 'http://invalid');
    if (
      !process.env.OPENCODE_MODEL ||
      endpoint.hostname !== 'host.docker.internal' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !process.env.NANOCLAW_DESKTOP_ROOM_IMAGE
    )
      throw new Error('Select the explicit credential-free local model and test image.');
    const agentID = `ag-${randomUUID()}`;
    const clientID = randomUUID();
    const phrase = `ATTACHED_FILE_VERIFIED_${randomUUID().replaceAll('-', '')}`;
    const bytes = Buffer.from(phrase + '\n');
    const evidence: Record<string, unknown> = {
      passed: false,
      model: process.env.OPENCODE_MODEL,
      agent_id: agentID,
      client_id: clientID,
      phrase,
      test_root: paths.root,
    };
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await dispatch({ id: randomUUID(), command: name, args }, { caller: 'host' });
      if (!result.ok) throw new Error(result.error.message);
      return result.data as Record<string, unknown>;
    }
    fs.mkdirSync(paths.root + '/data', { recursive: true });
    await runMigrations(await initTestDb());
    resetGatewayProvider({ kind: 'synthetic-local-no-credentials', contribute: async () => ({}) });
    try {
      const folder = 'synthetic-attachment-agent';
      fs.mkdirSync(`${paths.root}/groups/${folder}`, { recursive: true });
      fs.writeFileSync(
        `${paths.root}/groups/${folder}/CLAUDE.md`,
        'This is an isolated integration test. Read only the file explicitly attached in your inbox using the file-read tool. Never contact external services or other agents. Reply concisely with the requested file contents.',
      );
      await createUser({
        id: 'cli:local',
        kind: 'human',
        display_name: 'Synthetic operator',
        created_at: new Date().toISOString(),
      });
      await createAgentGroup({
        id: agentID,
        name: 'Synthetic attachment reader',
        folder,
        agent_provider: 'opencode',
        created_at: new Date().toISOString(),
      });
      await ensureContainerConfig(agentID, 'opencode');
      await updateContainerConfigScalars(agentID, {
        provider: 'opencode',
        model: process.env.OPENCODE_MODEL,
        image_tag: process.env.NANOCLAW_DESKTOP_ROOM_IMAGE,
        cli_scope: 'disabled',
        max_messages_per_prompt: 10,
      });
      // Pin this synthetic group's connection and disable inherited auth modes.
      await getDb().run(
        'UPDATE container_configs SET provider_settings = ? WHERE agent_group_id = ?',
        JSON.stringify({
          opencode: {
            authMode: null,
            modelProvider: 'openai',
            baseUrl: endpoint.toString(),
            smallModel: process.env.OPENCODE_MODEL,
            contextLimit: 32768,
            outputLimit: 2048,
            inputModalities: 'text',
          },
        }),
        agentID,
      );
      await addMember({
        user_id: 'cli:local',
        agent_group_id: agentID,
        added_by: 'cli:local',
        added_at: new Date().toISOString(),
      });
      await initChannelAdapters(() => ({ onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {} }));
      await startCliServer(paths.root + '/data/ncl.sock');
      setDeliveryAdapter(createChannelDeliveryAdapter());
      startActiveDeliveryPoll();
      const group = await call('messaging-groups-create', {
        channel_type: 'cli',
        instance: 'cli',
        platform_id: `desktop-${agentID}`,
        is_group: 0,
        unknown_sender_policy: 'strict',
      });
      const messagingGroupID = String(group.id);
      await call('wirings-create', {
        messaging_group_id: messagingGroupID,
        agent_group_id: agentID,
        session_mode: 'shared',
        sender_scope: 'all',
        engage_mode: 'pattern',
        engage_pattern: '.',
      });
      const receipt = await call('desktop-conversation-send', {
        agent_id: agentID,
        messaging_group_id: messagingGroupID,
        client_id: clientID,
        text: 'Read the attached verification.txt using the file-read tool. It contains a unique verification phrase. Reply with exactly the phrase from the file, with no other text.',
        attachments: [{ name: 'verification.txt', data: bytes.toString('base64'), mimeType: 'text/plain' }],
      });
      expect(receipt.accepted).toBe(true);
      evidence.receipt = receipt;
      const session = await findSessionForAgent(agentID, messagingGroupID, null);
      expect(session).toBeDefined();
      evidence.session_id = session!.id;
      const inbound = await withExistingMailboxSession(agentID, session!.id, (mailbox) =>
        mailbox.getInboundHistory(10),
      );
      const content = inbound!
        .map((row) => JSON.parse(row.content) as Record<string, unknown>)
        .find((row) => row.desktopClientId === clientID)!;
      const attachment = (content.attachments as Record<string, unknown>[])[0];
      expect(attachment.data).toBeUndefined();
      expect(attachment.size).toBe(bytes.length);
      const staged = fs.readFileSync(path.join(sessionDir(agentID, session!.id), String(attachment.localPath)));
      expect(staged.equals(bytes)).toBe(true);
      evidence.inbox = attachment;
      let reply = '';
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const rows = await withExistingMailboxSession(agentID, session!.id, (mailbox) =>
          mailbox.getOutboundHistory(100),
        );
        for (const row of rows ?? []) {
          const data = JSON.parse(row.content) as Record<string, unknown>;
          if (typeof data.text === 'string' && data.text.includes(phrase)) reply = data.text;
        }
        if (reply) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      evidence.reply = reply;
      expect(reply).toContain(phrase);
      evidence.passed = true;
    } finally {
      stopDeliveryPolls();
      await stopCliServer();
      await teardownChannelAdapters();
      const ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=nanoclaw-install=${paths.slug}`], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) {
        fs.writeFileSync(
          path.join(paths.root, `${id}.log`),
          execFileSync('docker', ['logs', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
        );
      }
      if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'pipe' });
      const remaining = execFileSync('docker', ['ps', '-aq', '--filter', `label=nanoclaw-install=${paths.slug}`], {
        encoding: 'utf8',
      }).trim();
      evidence.cleanup_verified = remaining === '';
      for (let tick = 0; tick < 30; tick++) {
        if ((await getActiveSessions()).every((session) => session.container_status === 'stopped')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await closeDb();
      fs.writeFileSync(path.join(paths.root, 'result.json'), JSON.stringify(evidence, null, 2));
      expect(remaining).toBe('');
      // Preserve synthetic result/inbox/log evidence; no user state was accessed.
    }
  }, 240_000);
});
