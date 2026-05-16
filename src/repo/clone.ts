import { join, normalize, resolve, sep } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
const DEFAULT_CLONE_TIMEOUT_MS = 300_000; // 5 minutes
const CLONE_TIMEOUT_MS = (() => {
  const raw = process.env.SLOPRIDER_CLONE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLONE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_TIMEOUT_MS;
})();
export class GitCloneError extends Error {
  readonly url: string;
  readonly isTimeout: boolean;
  readonly isAuthError: boolean;
  readonly isCanceled: boolean;
  constructor(
    message: string,
    url: string,
    isTimeout = false,
    isAuthError = false,
    isCanceled = false
  ) {
    super(message);
    this.name = 'GitCloneError';
    this.url = url;
    this.isTimeout = isTimeout;
    this.isAuthError = isAuthError;
    this.isCanceled = isCanceled;
  }
}
export interface CloneRepoOptions {
  onProgress?: (message: string) => void;
}
function normalizeGitProgress(chunk: string): string[] {
  return chunk
    .split(/\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
async function readGitStderr(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (message: string) => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let stderr = '';
  let lastProgress = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      stderr += chunk;
      for (const line of normalizeGitProgress(chunk)) {
        if (line !== lastProgress) {
          lastProgress = line;
          onProgress?.(line);
        }
      }
    }
    const tail = decoder.decode();
    if (tail) stderr += tail;
  } finally {
    reader.releaseLock();
  }
  return stderr;
}
export async function cloneRepo(
  url: string,
  ref?: string,
  options: CloneRepoOptions = {}
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'sloprider-'));
  const cloneOptions = ref ? ['--depth', '1', '--branch', ref] : ['--depth', '1'];
  const proc = Bun.spawn(
    [
      'git',
      '-c',
      'filter.lfs.required=false',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.process=',
      'clone',
      '--progress',
      ...cloneOptions,
      url,
      tempDir,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
    }
  );
  let timedOut = false;
  let canceled = false;
  const cancelClone = () => {
    canceled = true;
    proc.kill();
  };
  process.once('SIGINT', cancelClone);
  process.once('SIGTERM', cancelClone);
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, CLONE_TIMEOUT_MS);
  try {
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      readGitStderr(proc.stderr, options.onProgress),
    ]);
    clearTimeout(timeout);
    if (exitCode !== 0) {
      throw new Error(
        canceled
          ? 'git clone canceled'
          : timedOut
            ? 'git clone timed out'
            : stderr.trim() || `git clone exited with code ${exitCode}`
      );
    }
    return tempDir;
  } catch (error) {
    clearTimeout(timeout);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isCanceled = canceled || errorMessage.includes('canceled');
    const isTimeout =
      timedOut || errorMessage.includes('timed out') || errorMessage.includes('SIGTERM');
    const isAuthError =
      errorMessage.includes('Authentication failed') ||
      errorMessage.includes('could not read Username') ||
      errorMessage.includes('Permission denied') ||
      errorMessage.includes('Repository not found');
    if (isCanceled) {
      throw new GitCloneError(`Clone canceled for ${url}`, url, false, false, true);
    }
    if (isTimeout) {
      const seconds = Math.round(CLONE_TIMEOUT_MS / 1000);
      throw new GitCloneError(
        `Clone timed out after ${seconds}s. Common causes:\n` +
          `  - Large repository: raise the timeout with SLOPRIDER_CLONE_TIMEOUT_MS=600000 (10m)\n` +
          `  - Slow network: retry, or use a smaller git repository URL\n` +
          `  - Private repo without credentials: ensure auth is configured\n` +
          `      - For SSH: ssh-add -l (to check loaded keys)\n` +
          `      - For HTTPS: gh auth status (if using GitHub CLI)`,
        url,
        true,
        false,
        false
      );
    }
    if (isAuthError) {
      throw new GitCloneError(
        `Authentication failed for ${url}.\n` +
          `  - For private repos, ensure you have access\n` +
          `  - For SSH: Check your keys with 'ssh -T git@github.com'\n` +
          `  - For HTTPS: Run 'gh auth login' or configure git credentials`,
        url,
        false,
        true,
        false
      );
    }
    throw new GitCloneError(`Failed to clone ${url}: ${errorMessage}`, url, false, false, false);
  } finally {
    process.off('SIGINT', cancelClone);
    process.off('SIGTERM', cancelClone);
  }
}
export async function cleanupTempDir(dir: string): Promise<void> {
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));
  if (!normalizedDir.startsWith(normalizedTmpDir + sep) && normalizedDir !== normalizedTmpDir) {
    throw new Error('Attempted to clean up directory outside of temp directory');
  }
  await rm(dir, { recursive: true, force: true });
}
