import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { promisify } from 'util';
import type { AgentType, DiscoveredPlugin } from './types.ts';
import type { Scope } from './discover.ts';
import {
  toCodexEntry,
  upsertCodexMarketplaceEntry,
  type PluginPolicyInstallation,
} from './plugin-marketplace.ts';

const execFileAsync = promisify(execFile);

export type PluginCapableAgent = Extract<AgentType, 'codex' | 'claude-code'>;
export const pluginCapableAgents: PluginCapableAgent[] = ['codex', 'claude-code'];

export function getPluginCapableAgents(): PluginCapableAgent[] {
  return pluginCapableAgents;
}

function claudeScope(scope: Scope): string {
  return scope === 'global' ? 'user' : 'project';
}

export function buildClaudePluginCommand(
  action:
    | 'marketplace-add'
    | 'marketplace-update'
    | 'marketplace-list'
    | 'list'
    | 'install'
    | 'uninstall',
  value: string | undefined,
  scope: Scope
): string[] {
  if (action === 'marketplace-add') {
    if (!value) throw new Error('source is required');
    return ['plugin', 'marketplace', 'add', value, '--scope', claudeScope(scope)];
  }
  if (action === 'marketplace-update') {
    if (!value) throw new Error('marketplace is required');
    return ['plugin', 'marketplace', 'update', value];
  }
  if (action === 'marketplace-list') {
    return ['plugin', 'marketplace', 'list', '--json'];
  }
  if (action === 'list') {
    return ['plugin', 'list', '--json'];
  }
  if (action === 'install') {
    if (!value) throw new Error('plugin is required');
    return ['plugin', 'install', value, '--scope', claudeScope(scope)];
  }
  if (!value) throw new Error('plugin is required');
  return ['plugin', 'uninstall', value, '--scope', claudeScope(scope)];
}

export async function runClaudePluginCommand(args: string[]): Promise<void> {
  await execClaudePluginCommand(args);
}

export type ClaudeInstalledPlugin = {
  id: string;
  version?: string;
  scope: Scope;
  enabled?: boolean;
  installPath?: string;
};

type ClaudePluginListEntry = {
  id?: unknown;
  version?: unknown;
  scope?: unknown;
  enabled?: unknown;
  installPath?: unknown;
};

export function parseClaudePluginList(output: string): ClaudeInstalledPlugin[] {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry: ClaudePluginListEntry) => {
    if (!entry || typeof entry.id !== 'string') return [];
    const scope = entry.scope === 'project' ? 'project' : entry.scope === 'user' ? 'global' : null;
    if (!scope) return [];

    return [
      {
        id: entry.id,
        version: typeof entry.version === 'string' ? entry.version : undefined,
        scope,
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined,
        installPath: typeof entry.installPath === 'string' ? entry.installPath : undefined,
      },
    ];
  });
}

export function splitClaudePluginId(id: string): { name: string; marketplaceName?: string } {
  const separator = id.lastIndexOf('@');
  if (separator <= 0 || separator === id.length - 1) return { name: id };
  return {
    name: id.slice(0, separator),
    marketplaceName: id.slice(separator + 1),
  };
}

export function isClaudePluginNotFoundError(error: unknown, pluginName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`Plugin "${pluginName}" not found in installed plugins`);
}

function commandNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

function claudeCommandCandidates(): string[] {
  const candidates = commandNames('claude');
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of commandNames('claude')) {
      const command = join(dir, name);
      if (existsSync(command)) candidates.push(command);
    }
  }
  return [...new Set(candidates)];
}

async function execClaudePluginCommand(args: string[]): Promise<void> {
  let lastError: unknown;
  for (const command of claudeCommandCandidates()) {
    try {
      await execFileAsync(command, args);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EINVAL') throw error;
    }
  }
  throw lastError;
}

export async function listClaudeInstalledPlugins(): Promise<ClaudeInstalledPlugin[]> {
  for (const command of claudeCommandCandidates()) {
    try {
      const { stdout } = await execFileAsync(
        command,
        buildClaudePluginCommand('list', undefined, 'global')
      );
      return parseClaudePluginList(stdout);
    } catch {
      // Keep looking: bun/npm scripts can put a non-Claude-Code shim earlier on PATH.
    }
  }
  return [];
}

export async function addMarketplaceForAgent(
  source: string,
  agent: PluginCapableAgent,
  scope: Scope
): Promise<void> {
  if (agent === 'claude-code') {
    await runClaudePluginCommand(buildClaudePluginCommand('marketplace-add', source, scope));
  }
}

export function isClaudeMarketplaceOutOfDateError(
  error: unknown,
  pluginName: string,
  marketplaceName: string
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Plugin "${pluginName}" not found in marketplace "${marketplaceName}"`) &&
    message.includes('local copy may be out of date')
  );
}

export async function installPluginForAgent(
  plugin: DiscoveredPlugin,
  agent: PluginCapableAgent,
  scope: Scope,
  policy: PluginPolicyInstallation
): Promise<{ success: boolean; marketplacePath?: string; error?: string }> {
  try {
    if (agent === 'codex') {
      const marketplacePath = await upsertCodexMarketplaceEntry(
        scope,
        toCodexEntry(plugin, policy)
      );
      return { success: true, marketplacePath };
    }

    if (!plugin.marketplaceName) {
      return {
        success: false,
        error:
          'Claude Code plugin installs require a marketplace entry; publish the plugin through .claude-plugin/marketplace.json.',
      };
    }

    const marketplaceName = plugin.marketplaceName;
    const installSpec = `${plugin.name}@${marketplaceName}`;
    try {
      await runClaudePluginCommand(buildClaudePluginCommand('install', installSpec, scope));
    } catch (error) {
      if (!isClaudeMarketplaceOutOfDateError(error, plugin.name, marketplaceName)) {
        throw error;
      }
      await runClaudePluginCommand(
        buildClaudePluginCommand('marketplace-update', marketplaceName, scope)
      );
      await runClaudePluginCommand(buildClaudePluginCommand('install', installSpec, scope));
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function removePluginForAgent(
  name: string,
  agent: PluginCapableAgent,
  scope: Scope
): Promise<boolean> {
  if (agent !== 'claude-code') return false;
  const { name: unqualifiedName } = splitClaudePluginId(name);
  const candidates = [...new Set([name, unqualifiedName])];

  for (const candidate of candidates) {
    try {
      await execClaudePluginCommand(buildClaudePluginCommand('uninstall', candidate, scope));
      return true;
    } catch (error) {
      if (!isClaudePluginNotFoundError(error, candidate)) throw error;
    }
  }

  return false;
}
