import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { McpServer } from './mcp-types.ts';

const GLOBAL_LOCK_FILE = '.mcp-lock.json';
const LOCAL_LOCK_FILE = 'agentart-mcp-lock.json';
const CURRENT_VERSION = 1;

export interface McpLockEntry {
  server: McpServer;
  source: string;
  sourceType: 'direct' | 'local' | 'github' | 'gitlab' | 'git';
  installedAt: string;
  updatedAt: string;
}

export interface McpLockFile {
  version: number;
  mcps: Record<string, McpLockEntry>;
}

function emptyLock(): McpLockFile {
  return { version: CURRENT_VERSION, mcps: {} };
}

export function getGlobalMcpLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return join(xdgStateHome, 'agentart', GLOBAL_LOCK_FILE);
  }
  return join(homedir(), '.agents', GLOBAL_LOCK_FILE);
}

export function getLocalMcpLockPath(cwd?: string): string {
  return join(cwd || process.cwd(), LOCAL_LOCK_FILE);
}

export async function readMcpLock(
  options: { global?: boolean; cwd?: string } = {}
): Promise<McpLockFile> {
  const lockPath = options.global ? getGlobalMcpLockPath() : getLocalMcpLockPath(options.cwd);
  try {
    const content = await readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as McpLockFile;
    if (parsed.version !== CURRENT_VERSION || !parsed.mcps) {
      return emptyLock();
    }
    return parsed;
  } catch {
    return emptyLock();
  }
}

export async function writeMcpLock(
  lock: McpLockFile,
  options: { global?: boolean; cwd?: string } = {}
): Promise<void> {
  const lockPath = options.global ? getGlobalMcpLockPath() : getLocalMcpLockPath(options.cwd);
  await mkdir(dirname(lockPath), { recursive: true });

  const sorted: Record<string, McpLockEntry> = {};
  for (const key of Object.keys(lock.mcps).sort()) {
    sorted[key] = lock.mcps[key]!;
  }

  await writeFile(
    lockPath,
    JSON.stringify({ version: lock.version, mcps: sorted }, null, 2) + '\n'
  );
}

export async function addMcpToLock(
  server: McpServer,
  entry: Omit<McpLockEntry, 'server' | 'installedAt' | 'updatedAt'>,
  options: { global?: boolean; cwd?: string } = {}
): Promise<void> {
  const lock = await readMcpLock(options);
  const now = new Date().toISOString();
  const existing = lock.mcps[server.name];
  lock.mcps[server.name] = {
    ...entry,
    server,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await writeMcpLock(lock, options);
}

export async function removeMcpFromLock(
  name: string,
  options: { global?: boolean; cwd?: string } = {}
): Promise<boolean> {
  const lock = await readMcpLock(options);
  if (!(name in lock.mcps)) return false;
  delete lock.mcps[name];
  await writeMcpLock(lock, options);
  return true;
}
