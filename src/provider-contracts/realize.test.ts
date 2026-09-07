import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import './index.js';
import {
  protectedProviderDocumentSourcePaths,
  providerDocumentSourcePath,
  realizeProviderSpawnSurfaces,
} from './realize.js';
import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, getProviderHostContract, type ProviderHostContract } from './registry.js';

const ROOT = '/srv/nanoclaw';
const CANON = path.resolve(ROOT, 'container', 'CLAUDE.md');

function fakeContract(): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: {
      fileName: 'AGENTS.md',
      containerPath: '/workspace/agent/AGENTS.md',
      mountClass: 'group-state',
    },
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
  };
}

describe('protectedProviderDocumentSourcePaths', () => {
  it('protects the canonical template for the installed Claude contract', () => {
    expect(protectedProviderDocumentSourcePaths(ROOT)).toEqual([CANON]);
  });

  it('protects the canon regardless of which contracts are registered', () => {
    // Protection is core-owned since every contract renders from the one
    // canonical template; no declaration switches it on or off.
    expect(getProviderHostContract('claude')).toBeDefined();
    expect(providerDocumentSourcePath(ROOT, fakeContract())).toBe(CANON);
    expect(protectedProviderDocumentSourcePaths(ROOT)).toEqual([CANON]);
  });
});

describe('realizeProviderSpawnSurfaces', () => {
  async function realize(contract: ProviderHostContract) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'realize-blocked-hosts-'));
    try {
      const realization = await realizeProviderSpawnSurfaces('fake', contract, 'group-1', tmp, tmp, [], {
        legacyOverlay: () => Promise.resolve({ env: { A: '1' }, blockedHosts: ['adapter.example'] }),
        composeProjectDocument: () => Promise.resolve(),
      });
      return realization.contribution;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('carries the contract-declared blocked hosts into the spawn contribution', async () => {
    // Without this the declaration is silently inert: an Ollama group spawns
    // with the cloud endpoints reachable and no error anywhere.
    const contract = { ...fakeContract(), blockedHosts: ['api.anthropic.com', 'claude.ai'] };
    expect((await realize(contract)).blockedHosts).toEqual(['api.anthropic.com', 'claude.ai']);
  });

  it('blocks nothing when the contract declares nothing', async () => {
    const contribution = await realize(fakeContract());
    expect(contribution.blockedHosts).toBeUndefined();
    expect(contribution.env).toEqual({ A: '1' });
  });
});
