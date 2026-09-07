// A contract that wraps Claude's resolves drives the same SDK against another
// backend, so it needs somewhere to put reasoning-off and a narrowed built-in
// tool set. These pin both halves: what a derived contract asks for reaches the
// SDK options and the safety hook, and Claude's own options gain nothing.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import type { ProviderRuntimeContract } from '../provider-contracts/registry.js';

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-passthrough' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { ClaudeProvider, SDK_DISALLOWED_TOOLS } = await import('./claude.js');
const { resolveClaudeExecutionPolicy, resolveClaudeInference } = await import('./claude-config.js');
const { claudeRuntimeContract } = await import('../provider-contracts/claude.js');
const { registerProvider, registerProviderContract } = await import('./provider-registry.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

// A stand-in for a payload provider that reuses Claude's resolves: no server
// tools, no reasoning, a narrowed built-in set.
const derivedContract: ProviderRuntimeContract = {
  ...claudeRuntimeContract,
  configuration: {
    ...claudeRuntimeContract.configuration,
    executionPolicy: {
      constant: {
        ...resolveClaudeExecutionPolicy(),
        disallowedTools: [...SDK_DISALLOWED_TOOLS, 'WebFetch', 'WebSearch'],
        tools: ['Bash', 'Read'],
      },
    },
    inference: (input, environment) => ({
      ...resolveClaudeInference(input, environment),
      thinking: { type: 'disabled' as const },
    }),
  },
};

registerProvider('derived', (options, configuration) => new ClaudeProvider(options, configuration!));
registerProviderContract('derived', derivedContract);

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = undefined;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-passthrough-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(name: string): Promise<void> {
  const provider = createProvider(name, {});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  for await (const _ of provider.query({ prompt: 'hi', cwd: tmp }).events) {
    /* drain */
  }
}

function preToolUse(): (input: unknown) => Promise<Record<string, unknown>> {
  const hooks = lastOptions?.hooks as {
    PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<Record<string, unknown>>> }>;
  };
  return hooks.PreToolUse[0]!.hooks[0]!;
}

describe('a Claude-derived runtime contract', () => {
  it('carries thinking, the built-in tool set, and its extra disallowed tools into the SDK options', async () => {
    await drive('derived');

    expect(lastOptions?.thinking).toEqual({ type: 'disabled' });
    expect(lastOptions?.tools).toEqual(['Bash', 'Read']);
    expect(lastOptions?.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  });

  it('blocks its extra disallowed tools at the PreToolUse door too', async () => {
    await drive('derived');

    expect(await preToolUse()({ tool_name: 'WebFetch', tool_input: {} })).toMatchObject({ decision: 'block' });
  });
});

describe('the Claude contract itself', () => {
  it('sends no thinking or tools key, so its SDK options are what they always were', async () => {
    await drive('claude');

    expect(lastOptions && 'thinking' in lastOptions).toBe(false);
    expect(lastOptions && 'tools' in lastOptions).toBe(false);
    expect(lastOptions?.disallowedTools).toEqual(SDK_DISALLOWED_TOOLS);
  });

  it('keeps blocking its own disallowed list and nothing else', async () => {
    await drive('claude');

    expect(await preToolUse()({ tool_name: 'SendMessage', tool_input: {} })).toMatchObject({ decision: 'block' });
    expect(await preToolUse()({ tool_name: 'WebFetch', tool_input: {} })).toEqual({ continue: true });
  });
});
