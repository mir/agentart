import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { AgentType, PluginSourceDescriptor } from './types.ts';
import type { Scope } from './discover.ts';

const GLOBAL_LOCK_FILE = '.plugin-lock.json';
const LOCAL_LOCK_FILE = 'sloprider-plugin-lock.json';
const CURRENT_VERSION = 1;

export interface PluginLockEntry {
  name: string;
  agents: AgentType[];
  scope: Scope;
  source: string;
  sourceType: string;
  sourceUrl?: string;
  ref?: string;
  pluginPath: string;
  marketplaceName?: string;
  marketplacePath?: string;
  targetPath?: string;
  manifestHash?: string;
  pluginSource: PluginSourceDescriptor;
  sourceSha?: string;
  installedAt: string;
  updatedAt: string;
}

export interface PluginLockFile {
  version: number;
  plugins: Record<string, PluginLockEntry>;
}

function emptyLock(): PluginLockFile {
  return { version: CURRENT_VERSION, plugins: {} };
}

export function getPluginLockPath(options: { global?: boolean; cwd?: string } = {}): string {
  if (options.global) {
    const xdgStateHome = process.env.XDG_STATE_HOME;
    return xdgStateHome
      ? join(xdgStateHome, 'sloprider', GLOBAL_LOCK_FILE)
      : join(homedir(), '.agents', GLOBAL_LOCK_FILE);
  }
  return join(options.cwd || process.cwd(), LOCAL_LOCK_FILE);
}

export async function readPluginLock(
  options: { global?: boolean; cwd?: string } = {}
): Promise<PluginLockFile> {
  try {
    const parsed = JSON.parse(
      await readFile(getPluginLockPath(options), 'utf-8')
    ) as PluginLockFile;
    if (parsed.version !== CURRENT_VERSION || !parsed.plugins) return emptyLock();
    return parsed;
  } catch {
    return emptyLock();
  }
}

export async function writePluginLock(
  lock: PluginLockFile,
  options: { global?: boolean; cwd?: string } = {}
): Promise<void> {
  const path = getPluginLockPath(options);
  await mkdir(dirname(path), { recursive: true });
  const plugins: Record<string, PluginLockEntry> = {};
  for (const key of Object.keys(lock.plugins).sort()) plugins[key] = lock.plugins[key]!;
  await writeFile(path, JSON.stringify({ version: CURRENT_VERSION, plugins }, null, 2) + '\n');
}

export async function addPluginToLock(
  name: string,
  entry: Omit<PluginLockEntry, 'installedAt' | 'updatedAt'>,
  options: { global?: boolean; cwd?: string } = {}
): Promise<void> {
  const lock = await readPluginLock(options);
  const now = new Date().toISOString();
  const existing = lock.plugins[name];
  lock.plugins[name] = {
    ...entry,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await writePluginLock(lock, options);
}

export async function removePluginFromLock(
  name: string,
  options: { global?: boolean; cwd?: string } = {}
): Promise<PluginLockEntry | null> {
  const lock = await readPluginLock(options);
  const entry = lock.plugins[name];
  if (!entry) return null;
  delete lock.plugins[name];
  await writePluginLock(lock, options);
  return entry;
}
