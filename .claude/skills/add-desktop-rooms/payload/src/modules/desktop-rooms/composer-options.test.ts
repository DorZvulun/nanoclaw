import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  row: vi.fn(),
  config: vi.fn(),
  env: vi.fn().mockReturnValue({}),
  discover: vi.fn(),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: mocks.group }));
vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: mocks.row }));
vi.mock('../../container-config.js', () => ({ configFromDb: mocks.config }));
vi.mock('../../env.js', () => ({ readEnvFile: mocks.env }));
vi.mock('../opencode-channel-provisioning/model-discovery.js', () => ({ discoverOpenCodeModels: mocks.discover }));
import { composerOptions } from './composer-options.js';
import { lookup } from '../../cli/registry.js';
import { commandGuardSpec } from '../../cli/guard.js';

const id = 'c6f5630b-85c9-4591-88ef-1c4946b97351';
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'ANTHROPIC_BASE_URL',
    'OPENCODE_MODEL_CONTEXT_LIMIT',
    'OPENCODE_MODEL_OUTPUT_LIMIT',
    'OPENCODE_MODEL_INPUT_MODALITIES',
  ])
    vi.stubEnv(key, undefined);
  mocks.env.mockReturnValue({});
  mocks.group.mockResolvedValue({ id });
  mocks.row.mockResolvedValue({ model: 'openai/current', effort: 'high' });
  mocks.config.mockReturnValue({
    provider: 'opencode',
    model: 'openai/current',
    providerSettings: { opencode: { modelProvider: 'openai', baseUrl: 'http://127.0.0.1:8000/v1' } },
  });
  mocks.discover.mockResolvedValue([{ id: 'openai/next', name: 'Next', contextLimit: 2000 }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('desktop composer options', () => {
  it('rejects invalid IDs and caller-selected endpoints before querying', async () => {
    for (const invalid of ['', '   ', 'x'.repeat(257), 'agent\nname', null, 3])
      await expect(composerOptions({ id: invalid })).rejects.toThrow('agent ID');
    await expect(composerOptions({ id, base_url: 'https://outside.invalid' })).rejects.toThrow('Only an agent id');
    expect(mocks.group).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('rejects a missing group configuration', async () => {
    mocks.row.mockResolvedValue(undefined);
    await expect(composerOptions({ id })).rejects.toThrow('not found');
  });
  it('rejects a nonexistent opaque ID using the authoritative DB lookup', async () => {
    mocks.group.mockResolvedValue(undefined);
    await expect(composerOptions({ id: "unknown' OR 1=1--" })).rejects.toThrow('not found');
    expect(mocks.group).toHaveBeenCalledWith("unknown' OR 1=1--");
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('returns only model summaries and configured/effective state', async () => {
    const result = await composerOptions({ id });
    expect(result).toEqual({
      version: 1,
      agent_id: id,
      provider: 'opencode',
      model: 'openai/current',
      effective_model: 'openai/current',
      effort: 'high',
      can_configure_effort: true,
      effort_options: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
      models: [{ id: 'openai/next', name: 'Next' }],
      catalog_source: 'agent-connection',
      catalog_error: undefined,
      requires_restart: true,
    });
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(mocks.discover.mock.calls[0][0]).toMatchObject({
      provider_id: 'openai',
      base_url: 'http://127.0.0.1:8000/v1',
      models_url: null,
    });
  });
  it.each([null, '', false])('honors an explicit %s endpoint override without global fallback', async (baseUrl) => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://global.invalid/v1');
    mocks.config.mockReturnValue({ provider: 'opencode', providerSettings: { opencode: { baseUrl } } });
    const result = await composerOptions({ id });
    expect(result.can_configure_effort).toBe(false);
    expect(result.effort_options).toEqual(['']);
    expect(result.catalog_source).toBe('models.dev');
    expect(mocks.discover.mock.calls[0][0].base_url).toBeNull();
  });
  it('uses exported environment before dotenv, then applies the agent override', async () => {
    mocks.env.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://file.invalid/v1', OPENCODE_PROVIDER: 'file-provider' });
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://exported.invalid/v1');
    vi.stubEnv('OPENCODE_PROVIDER', 'exported-provider');
    mocks.config.mockReturnValue({
      provider: 'opencode',
      providerSettings: { opencode: { modelProvider: 'group-provider' } },
    });
    await composerOptions({ id });
    expect(mocks.discover.mock.calls[0][0]).toMatchObject({
      provider_id: 'group-provider',
      base_url: 'https://exported.invalid/v1',
    });
  });
  it('uses dotenv when the host does not export a connection', async () => {
    mocks.env.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://file.invalid/v1', OPENCODE_PROVIDER: 'file-provider' });
    mocks.config.mockReturnValue({ provider: 'opencode' });
    await composerOptions({ id });
    expect(mocks.discover.mock.calls[0][0]).toMatchObject({
      provider_id: 'file-provider',
      base_url: 'https://file.invalid/v1',
    });
  });
  it('keeps configured and inherited models distinct', async () => {
    mocks.row.mockResolvedValue({ model: null, effort: null });
    mocks.config.mockReturnValue({ provider: 'opencode', model: 'openai/inherited' });
    const result = await composerOptions({ id });
    expect(result.model).toBe('');
    expect(result.effective_model).toBe('openai/inherited');
    expect(result.effort).toBe('');
  });
  it('provides Claude aliases without claiming a live catalog', async () => {
    mocks.config.mockReturnValue({ provider: 'claude' });
    const result = await composerOptions({ id });
    expect(result.catalog_source).toBe('provider-aliases');
    expect(result.models.map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
    expect(result.can_configure_effort).toBe(true);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('does not invent reasoning support for unknown providers', async () => {
    mocks.config.mockReturnValue({ provider: 'unknown' });
    const result = await composerOptions({ id });
    expect(result.can_configure_effort).toBe(false);
    expect(result.models).toEqual([]);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('caps and sanitizes model summaries', async () => {
    mocks.discover.mockResolvedValue([
      { id: 'https://secret.invalid/?token=private', name: 'skip' },
      { id: 'openai/a', name: 'A\nmodel', secret: 'not returned' },
      { id: 'openai/a', name: 'duplicate' },
      ...Array.from({ length: 2_100 }, (_, index) => ({
        id: `openai/model-${index}`,
        name: 'x'.repeat(400),
        endpoint: 'private',
      })),
    ]);
    const result = await composerOptions({ id });
    expect(result.models).toHaveLength(2_000);
    expect(result.models[0]).toEqual({ id: 'openai/a', name: 'Amodel' });
    expect(result.models[1].name).toHaveLength(200);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('returns a generic error without endpoint or gateway exception details', async () => {
    mocks.discover.mockRejectedValue(new Error('token=private https://secret.invalid/v1'));
    const result = await composerOptions({ id });
    expect(result.catalog_error).toContain('Model discovery is unavailable');
    expect(result.model).toBe('openai/current');
    expect(JSON.stringify(result)).not.toMatch(/secret|private/);
  });
  it('rejects credential-bearing endpoint URLs without discovery', async () => {
    mocks.config.mockReturnValue({
      provider: 'opencode',
      providerSettings: { opencode: { baseUrl: 'https://name:password@secret.invalid/v1' } },
    });
    const result = await composerOptions({ id });
    expect(result.catalog_error).toBeDefined();
    expect(JSON.stringify(result)).not.toMatch(/password|secret/);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('returns within the response deadline when discovery hangs', async () => {
    vi.useFakeTimers();
    mocks.discover.mockReturnValue(new Promise(() => {}));
    const pending = composerOptions({ id });
    await vi.advanceTimersByTimeAsync(9_500);
    expect((await pending).catalog_error).toBeDefined();
  });
  it('registers an owner-only read endpoint and rejects container callers before DB access', async () => {
    const command = lookup('desktop-model-options')!;
    expect(command.hostOnly).toBe(true);
    expect(command.access).toBe('open');
    const spec = commandGuardSpec(command);
    expect((await spec.decide({ actor: { kind: 'host' }, payload: { id } })).effect).toBe('allow');
    expect((await spec.decide({ actor: { kind: 'agent', agentGroupId: id }, payload: { id } })).effect).toBe('deny');
    expect(mocks.row).not.toHaveBeenCalled();
  });
});
