import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { AgentType, PluginSourceDescriptor } from './types.ts';
import type { Scope } from './discover.ts';

const GLOBAL_REGISTRY_FILE = '.plugins.json';
const LOCAL_REGISTRY_FILE = 'sloprider-plugins.json';
const CURRENT_VERSION = 1;

export interface PluginRegistryEntry {
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

export interface PluginRegistryFile {
  version: number;
  plugins: Record<string, PluginRegistryEntry>;
}

function emptyRegistry(): PluginRegistryFile {
  return { version: CURRENT_VERSION, plugins: {} };
}

export function getPluginRegistryPath(options: { global?: boolean; cwd?: string } = {}): string {
  if (options.global) {
    const xdgStateHome = process.env.XDG_STATE_HOME;
    return xdgStateHome
      ? join(xdgStateHome, 'sloprider', GLOBAL_REGISTRY_FILE)
      : join(homedir(), '.agents', GLOBAL_REGISTRY_FILE);
  }
  return join(options.cwd || process.cwd(), LOCAL_REGISTRY_FILE);
}

export async function readPluginRegistry(
  options: { global?: boolean; cwd?: string } = {}
): Promise<PluginRegistryFile> {
  try {
    const parsed = JSON.parse(
      await readFile(getPluginRegistryPath(options), 'utf-8')
    ) as PluginRegistryFile;
    if (parsed.version !== CURRENT_VERSION || !parsed.plugins) return emptyRegistry();
    return parsed;
  } catch {
    return emptyRegistry();
  }
}

export async function writePluginRegistry(
  registry: PluginRegistryFile,
  options: { global?: boolean; cwd?: string } = {}
): Promise<void> {
  const path = getPluginRegistryPath(options);
  await mkdir(dirname(path), { recursive: true });
  const plugins: Record<string, PluginRegistryEntry> = {};
  for (const key of Object.keys(registry.plugins).sort()) plugins[key] = registry.plugins[key]!;
  await writeFile(path, JSON.stringify({ version: CURRENT_VERSION, plugins }, null, 2) + '\n');
}

export async function addPluginToRegistry(
  name: string,
  entry: Omit<PluginRegistryEntry, 'installedAt' | 'updatedAt'>,
  options: { global?: boolean; cwd?: string } = {}
): Promise<void> {
  const registry = await readPluginRegistry(options);
  const now = new Date().toISOString();
  const existing = registry.plugins[name];
  registry.plugins[name] = {
    ...entry,
    installedAt: existing?.installedAt ?? now,
    updatedAt: now,
  };
  await writePluginRegistry(registry, options);
}

export async function removePluginFromRegistry(
  name: string,
  options: { global?: boolean; cwd?: string } = {}
): Promise<PluginRegistryEntry | null> {
  const registry = await readPluginRegistry(options);
  const entry = registry.plugins[name];
  if (!entry) return null;
  delete registry.plugins[name];
  await writePluginRegistry(registry, options);
  return entry;
}
