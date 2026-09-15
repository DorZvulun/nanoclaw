# Mattermost callback security migration

## Detect

This applies to installations using the vendored
`src/channels/mattermost-adapter/` implementation from the `channels` branch.
Check `src/channels/mattermost.ts` and any custom Mattermost registration modules
for their imports before updating. A separately installed npm package or local
tarball needs its own package update; copying this directory will not replace it.

On the host, check whether `.env` has a nonblank `MATTERMOST_CALLBACK_URL` and
`MATTERMOST_CALLBACK_SECRET`. Report presence only, never their values. Custom
registrations must pass their secret as `callbackSecret` to `MattermostAdapter`.

## Why

Mattermost action callbacks have no server signature. The adapter authenticates
clicks using a shared secret in the action context. Previously, missing or blank
secrets could leave callbacks unauthenticated. An external per-button
`callbackUrl` also received the adapter's shared secret, allowing that integration
to forge actions against the adapter.

The adapter now requires a nonblank secret when a callback URL is configured.
Without a secret, ordinary action requests return 401. External buttons retain
their URL, action ID, and value, but receive no adapter credential. The configured
adapter route, its trailing-slash forms, and its `/actions` variant keep the
secret. Selects continue to use the adapter route.

## Fix

1. Back up the installed adapter and `.env` locally, keeping the backup private.
   Record the current source revision and the service that runs that checkout.
2. If a callback URL is configured and the secret is missing or blank, generate a
   cryptographically random secret on that host (at least 32 random bytes) and
   store it as `MATTERMOST_CALLBACK_SECRET` in the existing private `.env`.
   Pass it through custom registrations as `callbackSecret`. Do not print it,
   place it in command arguments, or commit it. Preserve an existing nonblank
   secret unless rotation is needed.
3. Review and apply the patched `adapter.ts`, `format.ts`, and `index.ts` from
   `src/channels/mattermost-adapter/` to the installed vendored directory. Preserve
   local customizations. Copy `adapter.test.ts` alongside them to verify
   the update. Use a reviewed revision containing this fix; do not merge the
   entire `channels` branch into an installed checkout.
4. Run the checks below, then rebuild and restart that installation's host through
   its normal operator-approved service procedure.
5. Reissue any cards posted without a secret or with a secret that has changed.
   If external buttons were previously used, review which integrations received
   them. Where a secret was exposed, rotate it on the adapter host and reissue
   affected cards. Old posts retain their original action context: patching the
   code alone does not remove credentials from already-posted integrations.

Without a callback URL, text delivery still works and cards degrade to markdown.
Without a callback secret, actions on stale cards are refused by default. Removing
only the callback URL does not disable authenticated callbacks on existing cards.
Setup callback proofs remain separately authenticated and cannot dispatch user
actions.

For isolated local tests only, direct adapter consumers can explicitly pass
`allowUnauthenticatedCallbacks: true`. The exported `createMattermostAdapter`
factory also accepts `MATTERMOST_ALLOW_UNAUTHENTICATED_CALLBACKS=true`, with an
explicit `false` option taking precedence. NanoClaw's standard registration uses
the constructor directly and does not enable that environment opt-out. A
configured secret remains enforced even with the option enabled. Never enable
unauthenticated callbacks on a route reachable by untrusted clients.

## Verify

From the updated checkout:

```sh
pnpm exec vitest run src/channels/mattermost-adapter src/channels/mattermost-registration.test.ts
pnpm run build
```

Before enabling traffic, confirm a forged action without the secret returns 401
and dispatches nothing. In a dedicated Mattermost test channel, confirm an ordinary
button or select still reaches the expected action and user. If testing external
buttons, use a controlled destination and verify it receives the action ID/value
without `callback_token`. Keep secrets out of receipts and logs. Existing cards
keep working when they already carry the unchanged secret.

## Rollback

If validation fails, retain the failure evidence and restore the backed-up code.
Disable external access to the callback route before running vulnerable code.
Keep any new or rotated secret; do not restore a known-exposed credential merely
to revive old cards. Rebuild and restart through the same installation-specific
procedure, then reissue cards as needed. A code rollback restores the old security
behavior, so keep the callback isolated until the fix can be reapplied.
