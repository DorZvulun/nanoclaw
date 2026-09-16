import { register } from '../../cli/registry.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { registerMigration } from '../../db/migrations/index.js';
import { routeInbound } from '../../router.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { canAccessAgentGroup } from '../permissions/access.js';
import { boundedText, fingerprint, OPERATOR, uuid } from './store.js';

const MAX_FILES = 8;
const MAX_BYTES = 2 * 1024 * 1024;
const UNCERTAIN = 'Delivery could not be confirmed. Check the conversation before sending a new message.';
interface Attachment {
  name: string;
  data: string;
  mimeType: string;
  size: number;
}
interface Receipt {
  client_id: string;
  message_id: string;
  fingerprint: string;
  state: 'routing' | 'accepted' | 'uncertain';
}

registerMigration({
  version: 2,
  name: 'module:desktop:conversation-sends-v2',
  async up(db) {
    // No payload or file bytes: the normal session inbox owns message content.
    // No cascading FK: deleting an agent must not allow reuse of an uncertain ID.
    await db.exec(`CREATE TABLE IF NOT EXISTS desktop_conversation_sends (
      client_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  },
});

function opaqueID(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /\p{Cc}/u.test(value))
    throw new Error(`${label} must be an existing agent or conversation ID.`);
  return value;
}
function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unsupported send fields.');
}
function attachments(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files.`);
  let total = 0;
  const names = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid attachment.');
    const item = raw as Record<string, unknown>;
    onlyKeys(item, ['name', 'data', 'mimeType']);
    const name = item.name;
    if (
      typeof name !== 'string' ||
      !isSafeAttachmentName(name) ||
      /\p{Cc}/u.test(name) ||
      Buffer.byteLength(name) > 240
    )
      throw new Error('Attachment names must be safe filenames of at most 240 bytes.');
    // Conservatively reject case/normalization collisions on macOS filesystems.
    const key = name.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('Each attachment needs a different filename.');
    names.add(key);
    if (
      typeof item.data !== 'string' ||
      item.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)
    )
      throw new Error('Attachment data must be base64 and files must total at most 2 MiB.');
    const bytes = Buffer.from(item.data, 'base64');
    if (bytes.toString('base64') !== item.data) throw new Error('Attachment data must be canonical base64.');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Attached files must total at most 2 MiB.');
    const mimeType = item.mimeType ?? 'application/octet-stream';
    if (typeof mimeType !== 'string' || mimeType.length > 160 || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType))
      throw new Error('Invalid attachment MIME type.');
    return { name, data: item.data, mimeType, size: bytes.length };
  });
}

async function validateRoute(agentID: string, messagingGroupID: string) {
  if (!(await getAgentGroup(agentID))) throw new Error('Agent no longer exists.');
  const group = await getMessagingGroup(messagingGroupID);
  const wires = await getMessagingGroupAgents(messagingGroupID);
  if (
    !group ||
    group.denied_at ||
    group.channel_type !== 'cli' ||
    group.instance !== 'cli' ||
    group.platform_id !== `desktop-${agentID}` ||
    group.is_group !== 0 ||
    wires.length !== 1 ||
    wires[0].agent_group_id !== agentID ||
    wires[0].session_mode !== 'shared' ||
    wires[0].engage_mode !== 'pattern' ||
    wires[0].engage_pattern !== '.' ||
    wires[0].sender_scope !== 'all'
  )
    throw new Error('Desktop conversation routing changed. Reconnect before sending.');
  if (group.unknown_sender_policy !== 'public' && !(await canAccessAgentGroup(OPERATOR, agentID)).allowed)
    throw new Error('Local operator needs existing access to this agent.');
  return group;
}

/** The router may decline silently. Confirm its actual inbox record, including staged files. */
async function isStaged(agentID: string, messagingGroupID: string, clientID: string, files: Attachment[]) {
  const sessions = await getDb().all<{ id: string }>(
    `SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 8`,
    agentID,
    messagingGroupID,
  );
  for (const session of sessions) {
    const found = await withExistingMailboxSession(agentID, session.id, (mailbox) =>
      mailbox.getInboundHistory(200).some((row) => {
        let content: Record<string, unknown>;
        try {
          content = JSON.parse(row.content) as Record<string, unknown>;
        } catch (error) {
          if (error instanceof SyntaxError) return false;
          throw error;
        }
        if (content?.desktopClientId !== clientID) return false;
        if (!files.length) return true;
        if (!Array.isArray(content.attachments) || content.attachments.length !== files.length) return false;
        const savedAttachments = content.attachments;
        return files.every((file, index) => {
          const saved = savedAttachments[index] as Record<string, unknown>;
          return (
            saved &&
            saved.name === file.name &&
            saved.size === file.size &&
            saved.data === undefined &&
            saved.localPath === `inbox/desktop-${clientID}:${agentID}/${file.name}`
          );
        });
      }),
    );
    if (found) return true;
  }
  return false;
}
function response(receipt: Receipt, duplicate: boolean) {
  const accepted = receipt.state === 'accepted';
  return {
    id: receipt.message_id,
    client_id: receipt.client_id,
    accepted,
    state: accepted ? 'accepted' : 'uncertain',
    duplicate,
    ...(accepted ? {} : { error: UNCERTAIN }),
  };
}

export async function sendConversation(args: Record<string, unknown>) {
  onlyKeys(args, ['agent_id', 'messaging_group_id', 'client_id', 'text', 'attachments']);
  const agentID = opaqueID(args.agent_id, 'agent_id');
  const messagingGroupID = opaqueID(args.messaging_group_id, 'messaging_group_id');
  const clientID = uuid(args.client_id, 'client_id');
  const text = boundedText(args.text ?? '', 'text', 64000);
  const files = attachments(args.attachments);
  if (!text.trim() && !files.length) throw new Error('Add a message or attachment before sending.');
  const group = await validateRoute(agentID, messagingGroupID);
  const stamp = fingerprint([agentID, messagingGroupID, text, files]);
  const claim = await getDb().transaction(async () => {
    const existing = await getDb().get<Receipt>(
      'SELECT * FROM desktop_conversation_sends WHERE client_id = ?',
      clientID,
    );
    if (existing) {
      if (existing.fingerprint !== stamp) throw new Error('client_id was already used for a different message.');
      return { receipt: existing, duplicate: true };
    }
    const receipt: Receipt = {
      client_id: clientID,
      message_id: `desktop-${clientID}`,
      fingerprint: stamp,
      state: 'routing',
    };
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO desktop_conversation_sends
      (client_id, message_id, fingerprint, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      clientID,
      receipt.message_id,
      stamp,
      receipt.state,
      now,
      now,
    );
    return { receipt, duplicate: false };
  });
  // A previous interrupted routing claim is uncertain forever; never replay it
  // into a newly rotated session. Retrying the identical payload only reads it.
  if (claim.duplicate) return response(claim.receipt, true);
  let accepted = false;
  try {
    await routeInbound({
      channelType: 'cli',
      instance: 'cli',
      platformId: group.platform_id,
      threadId: group.platform_id,
      message: {
        id: claim.receipt.message_id,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          text,
          sender: 'Desktop',
          senderId: OPERATOR,
          desktopClientId: clientID,
          ...(files.length ? { attachments: files } : {}),
        }),
      },
    });
    accepted = await isStaged(agentID, messagingGroupID, clientID, files);
    // Errors can be after inbox insertion; never expose internals or retry them.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    accepted = false;
  }
  claim.receipt.state = accepted ? 'accepted' : 'uncertain';
  await getDb().run(
    'UPDATE desktop_conversation_sends SET state = ?, updated_at = ? WHERE client_id = ?',
    claim.receipt.state,
    new Date().toISOString(),
    clientID,
  );
  return response(claim.receipt, false);
}

register({
  name: 'desktop-conversation-capabilities',
  description: 'Read local direct-conversation attachment limits.',
  access: 'open',
  hostOnly: true,
  parseArgs: (args) => args,
  handler: async () => ({ attachments: true, max_files: MAX_FILES, max_total_bytes: MAX_BYTES }),
});
register({
  name: 'desktop-conversation-send',
  description: 'Send text and files to an existing local direct agent conversation.',
  access: 'open',
  hostOnly: true,
  parseArgs: (args) => args,
  handler: sendConversation,
});
