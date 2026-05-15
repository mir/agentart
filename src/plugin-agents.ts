import { execFile } from 'child_process';
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
  action: 'marketplace-add' | 'marketplace-list' | 'install' | 'uninstall',
  value: string | undefined,
  scope: Scope
): string[] {
  if (action === 'marketplace-add') {
    if (!value) throw new Error('source is required');
    return ['plugin', 'marketplace', 'add', value, '--scope', claudeScope(scope)];
  }
  if (action === 'marketplace-list') {
    return ['plugin', 'marketplace', 'list', '--json'];
  }
  if (action === 'install') {
    if (!value) throw new Error('plugin is required');
    return ['plugin', 'install', value, '--scope', claudeScope(scope)];
  }
  if (!value) throw new Error('plugin is required');
  return ['plugin', 'uninstall', value, '--scope', claudeScope(scope)];
}

export async function runClaudePluginCommand(args: string[]): Promise<void> {
  await execFileAsync('claude', args);
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

    const installSpec = plugin.marketplaceName
      ? `${plugin.name}@${plugin.marketplaceName}`
      : plugin.name;
    await runClaudePluginCommand(buildClaudePluginCommand('install', installSpec, scope));
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
  await runClaudePluginCommand(buildClaudePluginCommand('uninstall', name, scope));
  return true;
}
