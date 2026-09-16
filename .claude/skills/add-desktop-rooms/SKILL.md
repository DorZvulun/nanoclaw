---
name: add-desktop-rooms
description: Add owner-only shared rooms, quiet peer context, threads, shared notes, and native management discovery for NanoClaw Desktop.
---

# Desktop rooms

This optional local channel gives the native desktop a shared conversation across
several agents. NanoClaw remains responsible for permissions, sessions, execution,
and outbound delivery. The channel opens no network listener: commands use the
existing owner-only host socket and reject every container caller.

Apply after the fork's selected agent providers. No new package dependency is
required. Add `add-desktop-rooms` after those providers in the fork's recipe.
The composer model catalog reuses this fork's OpenCode provider settings and
model-discovery helpers. Verify `src/providers/opencode.ts` and
`src/modules/opencode-channel-provisioning/model-discovery.ts` are present before
applying; install the selected OpenCode integration first if they are absent.
The integration tests import the composed module barrel, route through the real
router, and deliver from the real outbound mailbox through the host bridge.

## Apply

Work in an isolated task worktree. Copy every TypeScript file in
`payload/src/modules/desktop-rooms/` to `src/modules/desktop-rooms/`, including the
tests. Refresh those files when reapplying; they are owned by this skill.

Apply `host-provenance.patch` with `git apply --unidiff-zero --check` followed by `git apply --unidiff-zero`.
If the reverse check succeeds, the patch is already installed: leave it alone.
If neither check succeeds, adapt only the small trusted-provenance bridge to the
current host source, then run the integration tests. Never replace whole core
files with stale copies.

The bridge extends `OutboundMessage` with optional host provenance, forwards it
through the channel registry, and supplies it from the actual outbound mailbox
message/session in `delivery.ts`. Identity must never come from agent content.
These three small integration points are needed because the existing adapter
otherwise receives text without a trustworthy author or stable delivery ID.

Append `import './desktop-rooms/index.js';` once to `src/modules/index.ts`.
The module registers its own migration, commands, lifecycle callbacks and adapter.
Do not add a second startup path or change existing CLI conversation routes.

Run:

```bash
pnpm exec vitest run src/modules/desktop-rooms/composer-options.test.ts src/modules/desktop-rooms/conversation-send.test.ts src/modules/desktop-rooms/rooms.test.ts src/delivery.test.ts src/channels/channel-registry.test.ts
pnpm exec tsc --noEmit
pnpm run build
```

Back up the selected installation's database and service configuration before
installing the built host. Stop it cleanly before switching executables. Keep the
old executable for rollback. A container image rebuild is unnecessary: this skill
changes host delivery only. No existing room is created, agent granted access, or
message sent by startup.

## Behavior and limits

- Create a room with at least one agent the local operator already has permission
  to contact. Joining a room does not grant privileges.
- Every participant receives conversation context; only selected agents wake.
  Agent replies become quiet peer context, preventing automatic reply loops.
- Notes and purpose accompany explicitly targeted messages. Threads use their own
  sessions. Room history preserves stable message and author IDs.
- Send acknowledgements mean durable acceptance, not completed execution.
  Per-recipient receipts distinguish pending, routed, blocked and uncertain work.
- An interrupted routing claim is not automatically replayed: session-local
  deduplication cannot prove that repeating it in a new session is safe. Check
  that agent's session before sending a new message.
- Room version 1 supports text. Files and interactive questions are rejected without
  acknowledging delivery; they are never silently converted to plain text.
  Existing direct-message capabilities remain separate.
- Management discovery describes installed CLI resources. Approval records are
  read-only in this CLI; the catalog does not invent an approval-response action.
- `desktop-model-options` is a read-only, host-only command accepting only an
  existing agent ID as `id` (an opaque nonempty key of at most 256 characters,
  without control characters). Current `ag-UUID` and older timestamp IDs are
  supported; parameterized DB lookup verifies existence. It returns version 1,
  `agent_id`, `provider`, configured
  `model` and `effort` (empty strings mean default), `effective_model`,
  `can_configure_effort`, `effort_options`, `models` containing only `id`/`name`,
  `catalog_source`, optional generic `catalog_error`, and `requires_restart: true`.
  Claude choices are provider aliases. OpenCode choices come from the agent's
  effective custom connection through OneCLI, or models.dev for a standard
  connection. Explicit empty/null endpoint overrides suppress install defaults.
  Discovery returns at most 2,000 models with a 9.5-second response deadline;
  failure preserves current settings and permits a manual model ID. No raw
  endpoint, environment, credential, or gateway error is returned.
  Reasoning choices describe runtime forwarding, not guaranteed model support.
  OpenCode currently forwards effort only through custom-endpoint configuration.
  Saving a model/effort uses existing agent-global config and restart commands;
  it affects all that agent's conversations and may interrupt active replies.
  Primary-model changes retain existing small-model and model-limit settings.

## Direct conversation attachments

The host-only `desktop-conversation-capabilities` command returns
`{ attachments: true, max_files: 8, max_total_bytes: 2097152 }`. Older runtimes lack
this command; clients must explain the unavailable attachment control instead of
pretending that a file was attached.

The host-only `desktop-conversation-send` command accepts only `agent_id`,
`messaging_group_id`, a fresh UUID `client_id`, `text`, and optional `attachments`
containing `{ name, data, mimeType? }`. Agent and conversation IDs are opaque
existing DB keys. File data is canonical base64; at most eight files and 2 MiB
decoded aggregate are accepted. Names must be unique safe filenames (including
case/Unicode-normalization collision checks). Text is limited to 64,000 characters;
an empty text with files is valid. No host paths, sender overrides or destinations
can be supplied. Base64 uses the existing socket frame, without an upload service
or arbitrary host-file reading.

The selected route must be the existing `cli`/`cli` direct conversation at
`desktop-<agent_id>`, with exactly one shared, all-senders, `.` pattern wiring to
that agent. The local operator must already have access, or that exact route must
be public. Sending neither creates routes nor grants privileges. Normal inbound
routing and sandbox inbox staging remain authoritative.

The result is `{ id, client_id, accepted, state, duplicate, error? }`, where state
is `accepted` or `uncertain`. Acceptance is verified from the actual session inbox
record: files must have their expected staged `localPath` and no inline `data`.
This acknowledges receipt, not completion of the agent's work. Interception or
staging failure is uncertain, never silently reported as accepted.

The `module:desktop:conversation-sends-v2` migration adds an independent receipt
table containing client ID, fingerprint, message ID and state, with no text or
file payload. A claim is persisted before routing. Identical retries only query
that receipt; conflicting payloads are rejected. An interrupted claim is never
automatically replayed. A client must retain the exact payload and client ID after
uncertainty, check history before discarding it, and clear drafts/files only after
acceptance. Attachments currently apply to direct agent conversations; room file
fan-out and received room file delivery remain separate capabilities.

For opt-in inference verification, run
`src/modules/desktop-rooms/conversation-send.local-e2e.test.ts` with
`NANOCLAW_DESKTOP_ATTACHMENT_E2E=1`, an explicitly selected
`NANOCLAW_DESKTOP_ROOM_IMAGE`, `OPENCODE_MODEL`, and a credential-free
`ANTHROPIC_BASE_URL` on `host.docker.internal`. The test pins its synthetic agent
to that local connection, disabling inherited authentication. It sends a unique
phrase only inside a text attachment, verifies inbox bytes, and requires a real
agent reply containing that phrase. Its isolated data, result and logs remain in
`/tmp/ncl-attachment-e2e-<pid>`; only containers with that run's unique installation label
are removed. Existing user agents, routes and services are never used. The PNG
unit test verifies image bytes and MIME metadata, not vision capability.

## Troubleshooting

An unknown `desktop-rooms-list` command means the running host lacks the barrel
import or is still using the older executable. Verify the actual service program.
A routing-changed error means a dedicated room wiring was edited elsewhere;
restore its mention/accumulate/per-thread settings before retrying. A stale notes
revision means another editor saved first; reload and reconcile before saving.

## Removal

Follow [REMOVE.md](REMOVE.md). Room history is private user data and is preserved
unless the operator separately approves deleting it.
