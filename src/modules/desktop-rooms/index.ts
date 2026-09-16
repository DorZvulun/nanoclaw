import { managementCatalog } from './catalog.js';
import './composer-options.js';
import './conversation-send.js';
import { registerMigration } from '../../db/migrations/index.js';
import { register } from '../../cli/registry.js';
import { getDb } from '../../db/connection.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import type { ChannelDefaults } from '../../channels/adapter.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { desktopRoomsMigration } from './migration.js';
import { CHANNEL, uuid, createRoom, updateRoom, snapshot } from './store.js';
import {
  deliverRoom,
  sendRoom,
  history,
  receipts,
  retry,
  flushRoomQueue,
  startRoomQueue,
  stopRoomQueue,
  setRoomTyping,
} from './runtime.js';

registerMigration(desktopRoomsMigration);
const defaults: ChannelDefaults = {
  dm: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public', sessionMode: 'per-thread' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public', sessionMode: 'per-thread' },
  mentions: 'platform',
};
let connected = false;
registerChannelAdapter(CHANNEL, {
  defaults,
  factory: () => ({
    name: CHANNEL,
    channelType: CHANNEL,
    instance: CHANNEL,
    supportsThreads: true,
    defaults,
    async setup() {
      connected = true;
    },
    async teardown() {
      connected = false;
    },
    isConnected: () => connected,
    deliver: deliverRoom,
    async setTyping(platformID, threadID) {
      setRoomTyping(platformID, threadID);
    },
  }),
});
const handlers: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {
  capabilities: () => ({
    version: 1,
    threads: true,
    notes: true,
    targeted_send: true,
    peer_context: true,
    attachments: false,
  }),
  list: async () => {
    const ids = await getDb().all<{ id: string }>('SELECT id FROM desktop_rooms ORDER BY updated_at DESC, id');
    const rows = [];
    for (const { id } of ids) rows.push(await snapshot(id));
    return rows;
  },
  get: (args) => snapshot(uuid(args.id, 'id')),
  create: createRoom,
  update: updateRoom,
  send: sendRoom,
  history,
  receipts,
  retry,
};
for (const [verb, handler] of Object.entries(handlers))
  register({
    name: `desktop-rooms-${verb}`,
    description: `Local desktop room ${verb}. Owner-only socket.`,
    access: 'open',
    hostOnly: true,
    parseArgs: (args) => args,
    handler: async (args) => handler(args),
  });
let timer: ReturnType<typeof setInterval> | undefined;
onHostStart(async () => {
  await getDb().run(
    "UPDATE desktop_room_outbox SET state = 'uncertain', error = 'Service stopped during delivery. Check the agent session before sending again.' WHERE state = 'routing'",
  );
  startRoomQueue();
  timer = setInterval(() => {
    void flushRoomQueue().catch((err) => log.error('Desktop room queue failed', { err }));
  }, 1000);
  timer.unref();
});
onHostShutdown(() => {
  stopRoomQueue();
  if (timer) clearInterval(timer);
});

register({
  name: 'desktop-management-catalog',
  description: 'Native management forms for installed CLI resources.',
  access: 'open',
  hostOnly: true,
  parseArgs: (args) => args,
  handler: async () => managementCatalog(),
});
