import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { homedir } from 'os';
import type { DiscoveredPlugin, PluginSourceDescriptor } from './types.ts';
import type { Scope } from './discover.ts';

export type PluginPolicyInstallation = 'AVAILABLE' | 'INSTALLED_BY_DEFAULT';

export interface CodexMarketplaceEntry {
  name: string;
  source: PluginSourceDescriptor;
  policy: {
    installation: PluginPolicyInstallation;
    authentication: 'ON_INSTALL';
  };
  category: string;
}

export type CodexMarketplace = Record<string, unknown> & {
  plugins?: CodexMarketplaceEntry[];
};

export interface InstalledCodexPlugin {
  name: string;
  scope: Scope;
  agent: 'codex';
  marketplacePath: string;
  source: PluginSourceDescriptor;
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

export function getCodexMarketplacePath(scope: Scope, cwd = process.cwd()): string {
  return scope === 'global'
    ? join(homedir(), '.agents', 'plugins', 'marketplace.json')
    : join(cwd, '.agents', 'plugins', 'marketplace.json');
}

async function readMarketplace(path: string): Promise<CodexMarketplace> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as CodexMarketplace;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeMarketplace(path: string, marketplace: CodexMarketplace): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const plugins = [...(marketplace.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(path, JSON.stringify({ ...marketplace, plugins }, null, 2) + '\n', 'utf-8');
}

function sameSource(a: PluginSourceDescriptor, b: PluginSourceDescriptor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function codexPluginFolder(scope: Scope, name: string, cwd = process.cwd()): string {
  return scope === 'global' ? join(codexHome(), 'plugins', name) : join(cwd, 'plugins', name);
}

export function codexPluginRelativePath(scope: Scope, name: string, cwd = process.cwd()): string {
  const folder = codexPluginFolder(scope, name, cwd);
  return scope === 'global' ? folder : `./${relative(cwd, folder).split('\\').join('/')}`;
}

export function toCodexEntry(
  plugin: DiscoveredPlugin,
  policy: PluginPolicyInstallation,
  source: PluginSourceDescriptor = plugin.source
): CodexMarketplaceEntry {
  return {
    name: plugin.name,
    source,
    policy: { installation: policy, authentication: 'ON_INSTALL' },
    category: plugin.category ?? 'Productivity',
  };
}

export async function upsertCodexMarketplaceEntry(
  scope: Scope,
  entry: CodexMarketplaceEntry,
  cwd = process.cwd()
): Promise<string> {
  const path = getCodexMarketplacePath(scope, cwd);
  const marketplace = await readMarketplace(path);
  const plugins = marketplace.plugins ?? [];
  const existingIndex = plugins.findIndex(
    (plugin) => plugin.name.toLowerCase() === entry.name.toLowerCase()
  );
  if (existingIndex >= 0) {
    const existing = plugins[existingIndex]!;
    if (!sameSource(existing.source, entry.source)) {
      throw new Error(`Codex marketplace already contains plugin ${entry.name}.`);
    }
    plugins[existingIndex] = entry;
  } else {
    plugins.push(entry);
  }
  marketplace.plugins = plugins;
  await writeMarketplace(path, marketplace);
  return path;
}

export async function removeCodexMarketplaceEntry(
  name: string,
  scope: Scope,
  cwd = process.cwd()
): Promise<boolean> {
  const path = getCodexMarketplacePath(scope, cwd);
  const marketplace = await readMarketplace(path);
  const plugins = marketplace.plugins ?? [];
  const next = plugins.filter((plugin) => plugin.name.toLowerCase() !== name.toLowerCase());
  if (next.length === plugins.length) return false;
  marketplace.plugins = next;
  await writeMarketplace(path, marketplace);
  return true;
}

export async function listCodexMarketplacePlugins(
  scope: Scope,
  cwd = process.cwd()
): Promise<InstalledCodexPlugin[]> {
  const marketplacePath = getCodexMarketplacePath(scope, cwd);
  const marketplace = await readMarketplace(marketplacePath);
  return (marketplace.plugins ?? []).map((plugin) => ({
    name: plugin.name,
    scope,
    agent: 'codex',
    marketplacePath,
    source: plugin.source,
  }));
}
