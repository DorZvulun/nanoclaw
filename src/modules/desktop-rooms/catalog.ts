import { getResources, type ColumnDef, type ResourceDef } from '../../cli/crud.js';
import { listVerbs } from '../../cli/help-render.js';

const field = (name: string, type: ColumnDef['type'] = 'string', required = false, values?: string[]): ColumnDef => ({
  name,
  type,
  required,
  description: name.replace(/_/g, ' '),
  ...(values ? { enum: values } : {}),
});
const id = field('id', 'string', true);
const custom: Record<string, ColumnDef[]> = {
  'groups/create': ['folder', 'name', 'timezone', 'template', 'id']
    .map((n) => field(n))
    .concat([field('new', 'boolean'), field('yes', 'boolean')]),
  'groups/delete': [id],
  'groups/restart': [id, field('rebuild', 'boolean'), field('message')],
  'groups/config get': [id],
  'groups/config update': [
    id,
    ...['provider', 'model', 'effort', 'image_tag', 'assistant_name', 'timezone'].map((n) => field(n)),
    field('max_messages_per_prompt', 'number'),
    field('cli_scope', 'string', false, ['disabled', 'group', 'global']),
  ],
  'groups/config add-mcp-server': [
    id,
    field('name', 'string', true),
    field('command'),
    field('args'),
    field('env'),
    field('url'),
    field('headers'),
  ],
  'groups/config remove-mcp-server': [id, field('name', 'string', true)],
  'groups/config add-package': [id, field('apt'), field('npm')],
  'groups/config remove-package': [id, field('apt'), field('npm')],
  'groups/config add-mount': [
    id,
    field('host', 'string', true),
    field('container', 'string', true),
    field('ro', 'boolean'),
  ],
  'groups/config remove-mount': [id, field('host', 'string', true), field('container', 'string', true)],
  'messaging-groups/send': [
    field('channel_type', 'string', true),
    field('platform_id', 'string', true),
    field('text', 'string', true),
    field('instance'),
    field('sender'),
    field('sender_id'),
  ],
  'roles/grant': [
    field('user', 'string', true),
    field('role', 'string', true, ['owner', 'admin']),
    field('group'),
    field('granted_by'),
  ],
  'roles/revoke': [field('user', 'string', true), field('role', 'string', true, ['owner', 'admin']), field('group')],
  'members/add': [field('user', 'string', true), field('group', 'string', true), field('added_by')],
  'members/remove': [field('user', 'string', true), field('group', 'string', true)],
  'destinations/list': [field('agent_group_id')],
  'destinations/add': [
    field('agent_group_id', 'string', true),
    field('local_name', 'string', true),
    field('target_type', 'string', true, ['channel', 'agent']),
    field('target_id', 'string', true),
  ],
  'destinations/remove': [field('agent_group_id', 'string', true), field('local_name', 'string', true)],
  'policies/set': [field('from', 'string', true), field('to', 'string', true), field('approver', 'string', true)],
  'policies/remove': [field('from', 'string', true), field('to', 'string', true)],
  'opencode-model-providers/delete': [id],
};
const titles: Record<string, string> = {
  groups: 'Agents',
  'messaging-groups': 'Channels',
  wirings: 'Agent assignments',
  users: 'People',
  roles: 'Privileges',
  members: 'Agent access',
  destinations: 'Send destinations',
  policies: 'Approval policies',
  'user-dms': 'Contact routes',
  'dropped-messages': 'Undelivered messages',
  approvals: 'Approvals',
  sessions: 'Sessions',
  tasks: 'Automations',
  'opencode-model-providers': 'Model connections',
};
function fields(resource: ResourceDef, verb: string): ColumnDef[] | undefined {
  const operation = resource.customOperations?.[verb];
  if (operation) {
    if (operation.args) return operation.args;
    if (resource.plural === 'wirings' && verb === 'create')
      return resource.columns
        .filter((c) => !c.generated)
        .map((c): ColumnDef => ({ ...c, required: false }))
        .concat(['channel_type', 'platform_id', 'instance', 'agent_group'].map((n) => field(n)));
    return custom[`${resource.plural}/${verb}`];
  }
  switch (verb) {
    case 'list':
      return resource.columns
        .filter((c) => !c.generated)
        .map((c): ColumnDef => ({ ...c, required: false }))
        .concat([field('limit', 'number')]);
    case 'get':
    case 'delete':
      return [id];
    case 'create':
      return resource.columns.filter((c) => !c.generated);
    case 'update':
      return [id, ...resource.columns.filter((c) => c.updatable).map((c): ColumnDef => ({ ...c, required: false }))];
  }
}
/** Read-only schema, never serializes functions, credentials, or resource rows. */
export function managementCatalog() {
  return getResources().map((resource) => ({
    id: resource.plural,
    title: titles[resource.plural] ?? resource.description,
    description: resource.description,
    idColumn: resource.idColumn,
    operations: listVerbs(resource).map((verb) => {
      const args = fields(resource, verb);
      const readOnly = ['list', 'get', 'config get', 'history'].includes(verb);
      const destructive = ['delete', 'remove', 'revoke', 'cancel'].includes(verb) || verb.startsWith('config remove');
      return {
        id: `${resource.plural}-${verb.replace(/ /g, '-')}`,
        verb,
        title: verb.replace(/-/g, ' '),
        description:
          resource.customOperations?.[verb]?.description ?? `${verb} ${titles[resource.plural] ?? resource.plural}`,
        effect: readOnly
          ? 'read'
          : destructive
            ? 'destructive'
            : ['send', 'run', 'restart'].includes(verb)
              ? 'execute'
              : 'write',
        supported: args !== undefined,
        fields: args ?? [],
      };
    }),
  }));
}
