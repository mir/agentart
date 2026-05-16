import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { AgentType } from '../core/agents.ts';
const LOCK_FILE = 'sloprider-hook-lock.json';
const CURRENT_VERSION = 1;
export interface HookLockEntry {
  name: string;
  agent: Extract<AgentType, 'codex' | 'claude-code' | 'github-copilot'>;
  source: string;
  sourceType: 'github' | 'gitlab' | 'git';
  ref?: string;
  configPath: string;
  installedPath: string;
  events: string[];
  hooks: Record<string, unknown>;
  copiedFiles: Record<string, string>;
  sourceSha?: string;
  installedAt: string;
  updatedAt: string;
}
export interface HookLockFile {
  version: number;
  hooks: Record<string, HookLockEntry>;
}
function emptyLock(): HookLockFile {
  return { version: CURRENT_VERSION, hooks: {} };
}
export function getHookLockPath(cwd?: string): string {
  return join(cwd || process.cwd(), LOCK_FILE);
}
export async function readHookLock(cwd?: string): Promise<HookLockFile> {
  try {
    const content = await readFile(getHookLockPath(cwd), 'utf-8');
    const parsed = JSON.parse(content) as HookLockFile;
    if (parsed.version !== CURRENT_VERSION || !parsed.hooks) return emptyLock();
    return parsed;
  } catch {
    return emptyLock();
  }
}
export async function writeHookLock(lock: HookLockFile, cwd?: string): Promise<void> {
  const lockPath = getHookLockPath(cwd);
  await mkdir(dirname(lockPath), { recursive: true });
  const hooks: Record<string, HookLockEntry> = {};
  for (const key of Object.keys(lock.hooks).sort()) {
    hooks[key] = lock.hooks[key]!;
  }
  await writeFile(lockPath, JSON.stringify({ version: CURRENT_VERSION, hooks }, null, 2) + '\n');
}
export async function addHookToLock(
  name: string,
  entry: Omit<HookLockEntry, 'installedAt' | 'updatedAt'>,
  cwd?: string
): Promise<void> {
  const lock = await readHookLock(cwd);
  const now = new Date().toISOString();
  const existing = lock.hooks[name];
  lock.hooks[name] = {
    ...entry,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await writeHookLock(lock, cwd);
}
export async function removeHookFromLock(name: string, cwd?: string): Promise<boolean> {
  const lock = await readHookLock(cwd);
  if (!(name in lock.hooks)) return false;
  delete lock.hooks[name];
  await writeHookLock(lock, cwd);
  return true;
}
