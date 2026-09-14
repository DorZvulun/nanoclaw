import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectInstalledOneCLI } from './detect.js';
import { gatewayReadinessError } from './setup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OneCLI readiness', () => {
  it('detects only a configured gateway with a working v1 endpoint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-detect-'));
    roots.push(root);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    expect(await detectInstalledOneCLI(root, fetchImpl)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\n');
    expect(await detectInstalledOneCLI(root, fetchImpl)).toBe(true);
    fetchImpl.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await detectInstalledOneCLI(root, fetchImpl)).toBe(false);
  });

  it('refuses unreachable and pre-v1 gateways', () => {
    expect(gatewayReadinessError('ok')).toBeNull();
    expect(gatewayReadinessError('unreachable')).toMatch(/unreachable/);
    expect(gatewayReadinessError('incompatible')).toMatch(/lacks the \/v1 API/);
  });
});
