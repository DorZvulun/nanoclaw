import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectedKey = 'nanoclaw-local-web-selected-conversation';

function catalog(...conversations: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({
      conversations,
      installedProviders: ['ollama'],
      installationDefault: 'ollama',
      isInstallationDefaultInstalled: true,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function eventStream(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

async function loadControllerModule() {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/channels/local-web-conversation-ui.js')).href;
  return import(moduleUrl);
}

beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('document', { visibilityState: 'visible' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local web conversation controller', () => {
  it('adds an agent created outside the browser on the next visible catalog refresh', async () => {
    const main = { conversationId: 'mg-main', agentName: 'Main', provider: 'ollama', isLegacy: true };
    const child = { conversationId: 'mg-child', agentName: 'Child', provider: 'ollama', isLegacy: false };
    let catalogReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/conversations')
          return Promise.resolve(catalog(...(catalogReads++ === 0 ? [main] : [main, child])));
        if (url.startsWith('/events?')) return eventStream(init?.signal ?? undefined);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onCatalog = vi.fn();
    const module = await loadControllerModule();
    const controller = module.createConversationController({
      token: 'test-token',
      tokenHeader: 'x-test-token',
      onCatalog,
      onSelected: vi.fn(),
      onEvent: vi.fn(),
      onConnection: vi.fn(),
    });

    await controller.initialize();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ conversations: [main, child] }));
    controller.dispose();
  });

  it('falls back to the main chat when the selected agent is deleted', async () => {
    const main = { conversationId: 'mg-main', agentName: 'Main', provider: 'ollama', isLegacy: true };
    const child = { conversationId: 'mg-child', agentName: 'Child', provider: 'ollama', isLegacy: false };
    sessionStorage.setItem(selectedKey, child.conversationId);
    let catalogReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/conversations')
          return Promise.resolve(catalog(...(catalogReads++ === 0 ? [main, child] : [main])));
        if (url.startsWith('/events?')) return eventStream(init?.signal ?? undefined);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onSelected = vi.fn();
    const module = await loadControllerModule();
    const controller = module.createConversationController({
      token: 'test-token',
      tokenHeader: 'x-test-token',
      onCatalog: vi.fn(),
      onSelected,
      onEvent: vi.fn(),
      onConnection: vi.fn(),
    });

    await controller.initialize();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onSelected.mock.calls.map(([conversation]) => conversation.conversationId)).toEqual(['mg-child', 'mg-main']);
    expect(controller.selected.conversationId).toBe('mg-main');
    controller.dispose();
  });

  it('deletes the selected agent and falls back to the remaining conversation', async () => {
    const main = { conversationId: 'mg-main', agentName: 'Main', provider: 'ollama', isLegacy: true };
    const child = { conversationId: 'mg-child', agentName: 'Child', provider: 'ollama', isLegacy: false };
    sessionStorage.setItem(selectedKey, child.conversationId);
    let catalogReads = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/conversations')
        return Promise.resolve(catalog(...(catalogReads++ === 0 ? [main, child] : [main])));
      if (url === '/api/agents' && init?.method === 'DELETE') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, conversation: child }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/events?')) return eventStream(init?.signal ?? undefined);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSelected = vi.fn();
    const module = await loadControllerModule();
    const controller = module.createConversationController({
      token: 'test-token',
      tokenHeader: 'x-test-token',
      onCatalog: vi.fn(),
      onSelected,
      onEvent: vi.fn(),
      onConnection: vi.fn(),
    });

    await controller.initialize();
    await controller.deleteAgent(child.conversationId);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ conversationId: 'mg-child' }) }),
    );
    expect(controller.selected).toEqual(main);
    expect(onSelected.mock.calls.map(([conversation]) => conversation?.conversationId ?? null)).toEqual([
      'mg-child',
      'mg-main',
    ]);
    controller.dispose();
  });

  it('supports deleting the last agent and selecting a newly created one', async () => {
    const only = { conversationId: 'mg-only', agentName: 'Only', provider: 'ollama', isLegacy: true };
    const next = { conversationId: 'mg-next', agentName: 'Next', provider: 'ollama', isLegacy: false };
    let phase = 'initial';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/conversations') {
        if (phase === 'initial') return Promise.resolve(catalog(only));
        if (phase === 'deleted') return Promise.resolve(catalog());
        return Promise.resolve(catalog(next));
      }
      if (url === '/api/agents' && init?.method === 'DELETE') {
        phase = 'deleted';
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, conversation: only }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url === '/api/agents' && init?.method === 'POST') {
        phase = 'created';
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Next' });
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, created: true, conversation: next }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.startsWith('/events?')) return eventStream(init?.signal ?? undefined);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSelected = vi.fn();
    const module = await loadControllerModule();
    const controller = module.createConversationController({
      token: 'test-token',
      tokenHeader: 'x-test-token',
      onCatalog: vi.fn(),
      onSelected,
      onEvent: vi.fn(),
      onConnection: vi.fn(),
    });

    await controller.initialize();
    await controller.deleteAgent(only.conversationId);
    expect(controller.selected).toBeNull();
    expect(onSelected).toHaveBeenLastCalledWith(null, []);

    await controller.createAgent({ name: 'Next' });
    expect(controller.selected).toEqual(next);
    controller.dispose();
  });

  it('keeps the selected conversation when deletion fails', async () => {
    const child = { conversationId: 'mg-child', agentName: 'Child', provider: 'ollama', isLegacy: false };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/conversations') return Promise.resolve(catalog(child));
        if (url === '/api/agents' && init?.method === 'DELETE') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'Delete was rejected.' }), {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (url.startsWith('/events?')) return eventStream(init?.signal ?? undefined);
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const module = await loadControllerModule();
    const controller = module.createConversationController({
      token: 'test-token',
      tokenHeader: 'x-test-token',
      onCatalog: vi.fn(),
      onSelected: vi.fn(),
      onEvent: vi.fn(),
      onConnection: vi.fn(),
    });

    await controller.initialize();
    await expect(controller.deleteAgent(child.conversationId)).rejects.toThrow('Delete was rejected.');
    expect(controller.selected).toEqual(child);
    controller.dispose();
  });
});
