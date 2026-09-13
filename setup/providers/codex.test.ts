import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so runCodexLoginAuth never spawns a real codex CLI; the
// spawn stand-in plays `codex login` writing auth.json into whatever
// CODEX_HOME it was handed.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

import {
  buildCodexCliFailureMessage,
  buildCodexFailurePrompt,
  runCodexInstallCheck,
  runCodexLoginAuth,
  verifyCodexInstall,
} from './codex.js';
import * as setupLog from '../logs.js';

// No global mock reset is configured, so a stubbed spawn/spawnSync would
// otherwise leak into the next test and let a broken resolver pass on a
// neighbour's leftovers. Each test below arranges its own doubles.
beforeEach(() => {
  vi.resetAllMocks();
});

/** A project root whose CLI manifest pins @openai/codex to `version`. */
function manifestRoot(version: string | undefined): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-manifest-'));
  fs.mkdirSync(path.join(root, 'container'), { recursive: true });
  const entry =
    version === undefined ? { name: 'agent-browser', version: '0.27.1' } : { name: '@openai/codex', version };
  fs.writeFileSync(path.join(root, 'container', 'cli-tools.json'), JSON.stringify([entry]));
  return root;
}

/** Runs the auth flow expecting it to bail out via process.exit(1). */
async function expectAuthExit(run: () => Promise<void>): Promise<void> {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
    throw new Error('process.exit');
  }) as never);
  try {
    await expect(run()).rejects.toThrow('process.exit');
  } finally {
    exit.mockRestore();
  }
}

/** The ERROR field of the last failed `auth` step recorded by setupLog. */
function lastAuthFailureReason(): string | undefined {
  const calls = vi.mocked(setupLog.step).mock.calls.filter((c) => c[0] === 'auth' && c[1] === 'failed');
  const fields = calls.at(-1)?.[3] as Record<string, string> | undefined;
  return fields?.ERROR;
}

/** spawn stand-in that plays a successful `codex login` into CODEX_HOME. */
function playSuccessfulLogin(): void {
  mockSpawn.mockImplementation((...args: unknown[]) => {
    const opts = args[2] as { env?: NodeJS.ProcessEnv };
    fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
    const child = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  });
}

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const { ok, problems } = verifyCodexInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it('blocks setup when the payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-check-'));
    try {
      await expect(runCodexInstallCheck(root)).rejects.toThrow(/Codex provider is not fully installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Pure prompt builder for the failure-assist hook — no spawning involved.
describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const projectRoot = '/repo';
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      projectRoot,
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md'); // BIG_PICTURE_FILES
    expect(prompt).toContain('setup/verify.ts'); // STEP_FILES['verify']
    expect(prompt).toContain('logs/setup.log');
    expect(prompt).toContain('logs/setup-steps/verify.log'); // relativized rawLogPath
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

// Session-isolation invariant: the ChatGPT session vaulted for the gateway
// must never be the user's personal ~/.codex session — sharing one OAuth
// session across two consumers gets the whole family invalidated server-side
// when refresh tokens rotate (see the header of codex.ts).
describe('runCodexLoginAuth', () => {
  it('logs in under an isolated CODEX_HOME, vaults from it, and deletes it', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockExecFileSync.mockReturnValue('');

    let loginEnv: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      loginEnv = opts.env;
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCodexLoginAuth('browser');

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = loginEnv?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    const vaultCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'onecli');
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs[vaultArgs.indexOf('--file') + 1]).toBe(path.join(codexHome!, 'auth.json'));

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);
  });

  it('pins the manual install fallback to the same reviewed manifest version', () => {
    const message = buildCodexCliFailureMessage({
      reason: 'codex_cli_bootstrap_failed',
      pinnedVersion: '0.146.0',
    });

    expect(message).toContain('npm install -g @openai/codex@0.146.0 --prefix ~/.local');
    expect(message).not.toContain('npm install -g @openai/codex --prefix');
  });

  it('runs the manifest-pinned CLI through npx when codex is not installed on the host', async () => {
    const root = manifestRoot('0.146.0');
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0', stderr: '' });
    mockExecFileSync.mockReturnValue('');
    playSuccessfulLogin();

    try {
      await runCodexLoginAuth('device', root);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npx',
        ['--yes', '@openai/codex@0.146.0', '--version'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['--yes', '@openai/codex@0.146.0', 'login', '--device-auth'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({ CODEX_HOME: expect.any(String) }),
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The production caller (runCodexAuthStep) passes no root, so the default is
  // the only path a real operator takes — assert it reads the manifest from the
  // repo root that setup.sh cds into, not some other directory.
  it('reads the pinned version from process.cwd() when no project root is passed', async () => {
    const root = manifestRoot('0.146.0');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0', stderr: '' });
    mockExecFileSync.mockReturnValue('');
    playSuccessfulLogin();

    try {
      await runCodexLoginAuth('device');

      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['--yes', '@openai/codex@0.146.0', 'login', '--device-auth'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
    } finally {
      cwd.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Supply-chain gate: the manifest spec is handed to `npx --yes`, which installs
  // and runs on the HOST. A range or `latest` must fail closed rather than fetch
  // whatever the registry serves today.
  it('refuses an unpinned manifest version instead of fetching it', async () => {
    const root = manifestRoot('^0.146.0');
    // Everything downstream is armed for success, so the pin gate is the only
    // thing that can stop this: drop the gate and the flow logs in happily.
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0', stderr: '' });
    mockExecFileSync.mockReturnValue('');
    playSuccessfulLogin();

    try {
      await expectAuthExit(() => runCodexLoginAuth('device', root));

      expect(lastAuthFailureReason()).toBe('codex_cli_unpinned');
      // The npx probe is itself the install — it must not have run at all.
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(mockSpawnSync).not.toHaveBeenCalledWith('npx', expect.anything(), expect.anything());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an incomplete payload, not an npm problem, when the manifest has no codex entry', async () => {
    const root = manifestRoot(undefined);
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce({ status: 0, stdout: 'codex-cli 0.146.0', stderr: '' });
    mockExecFileSync.mockReturnValue('');
    playSuccessfulLogin();

    try {
      await expectAuthExit(() => runCodexLoginAuth('device', root));

      expect(lastAuthFailureReason()).toBe('codex_cli_missing');
      expect(mockSpawnSync).not.toHaveBeenCalledWith('npx', expect.anything(), expect.anything());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an unreadable manifest distinctly from a failed npx bootstrap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-nomanifest-'));
    mockSpawnSync.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' });

    try {
      await expectAuthExit(() => runCodexLoginAuth('device', root));

      expect(lastAuthFailureReason()).toBe('codex_cli_manifest_unreadable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a failed npx bootstrap once the pin is valid', async () => {
    const root = manifestRoot('0.146.0');
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'network unreachable' });

    try {
      await expectAuthExit(() => runCodexLoginAuth('device', root));

      expect(lastAuthFailureReason()).toBe('codex_cli_bootstrap_failed');
      // No login was attempted with a CLI that cannot run.
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
