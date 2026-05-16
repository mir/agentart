import { spawn } from 'child_process';
const LS_REMOTE_TIMEOUT_MS = 10_000;
export async function getCommitSha(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const sha = stdout.trim();
      resolve(sha || null);
    });
    proc.on('error', () => resolve(null));
  });
}
export async function lsRemoteSha(url: string, ref?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ['ls-remote', '--', url, ref || 'HEAD'];
    const proc = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    proc.on('close', (code) => {
      if (code !== 0) return finish(null);
      const first = stdout.split('\n').find((line) => line.trim());
      const sha = first?.split(/\s+/)[0];
      finish(sha || null);
    });
    proc.on('error', () => finish(null));
    setTimeout(() => {
      proc.kill();
      finish(null);
    }, LS_REMOTE_TIMEOUT_MS);
  });
}
