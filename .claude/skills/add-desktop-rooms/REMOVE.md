# Remove desktop rooms

Stop the selected host cleanly and back up its database and service configuration.
Remove the single desktop-rooms import from `src/modules/index.ts` and remove the
skill-owned `src/modules/desktop-rooms/` directory, including its tests.

Reverse `host-provenance.patch` with `git apply --unidiff-zero --reverse` only after confirming that no other installed
adapter relies on the optional `DeliverySource` bridge. If another skill uses it,
leave the shared generic bridge in place and document that ownership. Do not
blindly restore entire core files.

Remove the skill from the fork's recipe. Rebuild and run the host's normal tests,
then restore the selected service with the new build. No dependency, environment
variable, container image, or public listener was added by this skill.

The module's room tables, dedicated channel routes and transcript are user data.
The `desktop_conversation_sends` receipt table also remains intact when disabling
the module; it prevents uncertain direct sends being accidentally replayed after
reinstallation. It contains identifiers/fingerprints/status, not file payloads.
Disabling the module makes them inert but preserves them for reinstall or export.
For a complete data purge, first obtain explicit approval for the exact room IDs,
export their records, and use a separate reviewed database migration to remove
room receipts, messages, participant rows, room rows, and their dedicated wirings
and routes in foreign-key order. Do not drop or edit unrelated core data.

Removing this skill's own source directory is a separate repository change; retain
it when the intent is only to disable the installed module.
