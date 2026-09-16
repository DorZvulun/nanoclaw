import { register } from '../../cli/registry.js';
import { configFromDb } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { readEnvFile } from '../../env.js';
import { applyOpenCodeProviderSettings } from '../../providers/opencode.js';
import { discoverOpenCodeModels } from '../opencode-channel-provisioning/model-discovery.js';
import type { OpenCodeModelProvider } from '../opencode-channel-provisioning/types.js';

const ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;
// These are runtime passthrough values, not claims about model capabilities.
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const DISCOVERY_ERROR = 'Model discovery is unavailable. Keep the current model or enter a model ID.';
function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Owner-only, read-only view of this agent's existing connection. Never accepts a URL. */
export async function composerOptions(args: Record<string, unknown>) {
  // IDs are opaque DB keys: current generators use ag-UUID, while older installs
  // retain timestamp IDs. The parameterized lookup below establishes existence.
  if (typeof args.id !== 'string' || !args.id.trim() || args.id.length > 256 || /\p{Cc}/u.test(args.id))
    throw new Error('A nonempty agent ID of at most 256 characters without control characters is required.');
  if (Object.keys(args).some((key) => key !== 'id')) throw new Error('Only an agent id is accepted.');
  const group = await getAgentGroup(args.id);
  const row = await getContainerConfig(args.id);
  if (!group || !row) throw new Error('Agent configuration was not found.');
  const config = configFromDb(row, group);
  const provider = config.provider || 'claude';
  const result = {
    version: 1,
    agent_id: args.id,
    provider,
    model: row.model || '',
    effective_model: config.model || '',
    effort: row.effort || '',
    can_configure_effort: provider === 'claude',
    effort_options: provider === 'claude' ? [...EFFORTS] : [''],
    models: [] as { id: string; name: string }[],
    catalog_source: 'unavailable',
    requires_restart: true,
    catalog_error: undefined as string | undefined,
  };
  if (provider === 'claude') {
    // Aliases declared by ProviderOptions.model; these are not a live SDK catalog.
    result.models = ['sonnet', 'opus', 'haiku'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
    result.catalog_source = 'provider-aliases';
    return result;
  }
  if (provider !== 'opencode') return result;

  const dotenv = readEnvFile([...ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key] ?? dotenv[key];
    if (value) env[key] = value;
  }
  if (config.model) env.OPENCODE_MODEL = config.model;
  const settings = object(object(config.providerSettings)?.opencode);
  if (settings) applyOpenCodeProviderSettings(env, settings);
  const modelProvider = env.OPENCODE_PROVIDER || 'anthropic';
  const baseURL = env.ANTHROPIC_BASE_URL || null;
  result.effective_model = env.OPENCODE_MODEL || '';
  result.can_configure_effort = Boolean(baseURL);
  result.effort_options = baseURL ? [...EFFORTS] : [''];
  result.catalog_source = baseURL ? 'agent-connection' : 'models.dev';

  // Resolve from the agent's effective settings, never a similarly named saved connection.
  const connection: OpenCodeModelProvider = {
    id: 'desktop-agent-connection',
    name: modelProvider,
    provider_id: modelProvider,
    discovery_type: baseURL ? 'openai-compatible' : 'models-dev',
    base_url: baseURL,
    models_url: null,
    context_limit: positive(env.OPENCODE_MODEL_CONTEXT_LIMIT),
    output_limit: positive(env.OPENCODE_MODEL_OUTPUT_LIMIT),
    input_modalities: env.OPENCODE_MODEL_INPUT_MODALITIES || '',
    instructions: null,
    enabled: 1,
    created_at: '',
    updated_at: '',
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (baseURL) {
      const url = new URL(baseURL);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('Invalid discovery endpoint');
    }
    const models = await Promise.race([
      discoverOpenCodeModels(connection),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Discovery timeout')), 9_500);
      }),
    ]);
    const seen = new Set<string>();
    for (const model of models) {
      if (result.models.length === 2_000) break;
      if (typeof model.id !== 'string' || model.id.length > 512 || !/^[\w./-]+$/.test(model.id) || seen.has(model.id))
        continue;
      seen.add(model.id);
      const name =
        typeof model.name === 'string'
          ? model.name
              .replace(/\p{Cc}/gu, '')
              .trim()
              .slice(0, 200)
          : '';
      result.models.push({ id: model.id, name: name || model.id });
    }
    if (!result.models.length) result.catalog_error = DISCOVERY_ERROR;
    // Never serialize gateway exceptions, including unexpected ones, to a UI client.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    // The credential gateway's errors can contain endpoint/credential details.
    result.catalog_error = DISCOVERY_ERROR;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return result;
}

register({
  name: 'desktop-model-options',
  description: 'Read model choices and reasoning forwarding for one agent. Owner-only socket.',
  access: 'open',
  hostOnly: true,
  parseArgs: (args) => args,
  handler: composerOptions,
});
