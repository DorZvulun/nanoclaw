import fs from 'node:fs';
import path from 'node:path';

function envHasGateway(root: string): boolean {
  try {
    return /^ONECLI_URL=\S+/m.test(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

function gatewayUrl(root: string): string {
  try {
    return (
      fs
        .readFileSync(path.join(root, '.env'), 'utf8')
        .match(/^ONECLI_URL=(\S+)$/m)?.[1]
        ?.trim() ?? ''
    );
  } catch {
    return '';
  }
}

export async function detectInstalledOneCLI(root = process.cwd(), fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!envHasGateway(root)) return false;
  try {
    const response = await fetchImpl(new URL('/v1/health', gatewayUrl(root)), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log((await detectInstalledOneCLI()) ? 'installed' : 'absent');
}
