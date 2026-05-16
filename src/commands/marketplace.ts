import { basename, resolve } from 'path';
import * as p from '@clack/prompts';
import pc from '../ui/colors.ts';
import { parseSource } from '../core/source.ts';
import {
  addMarketplaceForAgent,
  buildClaudePluginCommand,
  getPluginCapableAgents,
} from '../artifacts/plugins.ts';
import {
  listCodexMarketplacePlugins,
  toCodexEntry,
  upsertCodexMarketplaceEntry,
} from '../artifacts/plugins.ts';
import type { AgentType } from '../core/agents.ts';
import type { PluginCatalogItem, PluginLocator } from '../core/artifacts.ts';
import { parseScope, type InstallScope } from '../core/scope.ts';
type Scope = InstallScope;
type ParsedArgs = {
  action: 'add' | 'list' | 'remove';
  source?: string;
  name?: string;
  scope: Scope;
  agents: AgentType[];
};
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
function parseAgents(value: string | undefined): AgentType[] {
  if (!value || value === 'all') return getPluginCapableAgents();
  const known = new Set(getPluginCapableAgents());
  const selected = splitList(value);
  const invalid = selected.filter((agent) => !known.has(agent as any));
  if (invalid.length > 0) throw new Error(`Agent(s) do not support plugins: ${invalid.join(', ')}`);
  return selected as AgentType[];
}
function parseMarketplaceArgs(args: string[]): ParsedArgs {
  const [action, value, ...rest] = args;
  if (action !== 'add' && action !== 'list' && action !== 'remove') {
    throw new Error(
      'Usage: sloprider marketplace add <source> --agents codex,claude-code --scope project|global'
    );
  }
  if (action !== 'list' && !value)
    throw new Error(`Usage: sloprider marketplace ${action} <source>`);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const name = rawName ?? '';
    const flagValue = inlineValue ?? rest[++i];
    if (!flagValue || flagValue.startsWith('--')) throw new Error(`Missing value for --${name}`);
    if (name !== 'scope' && name !== 'agents') throw new Error(`Unknown option: --${name}`);
    flags.set(name, flagValue);
  }
  return {
    action,
    source: action === 'add' ? value : undefined,
    name: action === 'remove' ? value : undefined,
    scope: parseScope(flags.get('scope') ?? 'project'),
    agents: parseAgents(flags.get('agents')),
  };
}
function sourceName(source: string): string {
  const parsed = parseSource(source);
  if (parsed.type === 'local') return basename(resolve(parsed.localPath ?? source));
  const clean = parsed.url
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .pop();
  return clean ?? basename(source);
}
function sourceDescriptor(source: string): PluginLocator {
  const parsed = parseSource(source);
  if (parsed.type === 'local') return { source: 'local', path: source };
  return { source: 'git-subdir', url: parsed.url, path: '.', ref: parsed.ref };
}
async function addMarketplace(
  source: string,
  scope: Scope,
  targetAgents: AgentType[]
): Promise<void> {
  const plugin: PluginCatalogItem = {
    name: sourceName(source),
    category: 'Productivity',
    configPath: source,
    source: sourceDescriptor(source),
  };
  for (const agent of targetAgents) {
    if (agent === 'codex') {
      await upsertCodexMarketplaceEntry(scope, toCodexEntry(plugin, 'AVAILABLE'));
    } else if (agent === 'claude-code') {
      await addMarketplaceForAgent(source, 'claude-code', scope);
    }
  }
}
async function listMarketplace(): Promise<void> {
  const [project, global] = await Promise.all([
    listCodexMarketplacePlugins('project'),
    listCodexMarketplacePlugins('global'),
  ]);
  for (const item of [...project, ...global]) {
    console.log(`${item.scope} codex ${item.name}`);
  }
  console.log(
    `claude-code: ${buildClaudePluginCommand('marketplace-list', undefined, 'project').join(' ')}`
  );
}
export async function runMarketplace(args: string[]): Promise<void> {
  const parsed = parseMarketplaceArgs(args);
  if (parsed.action === 'list') {
    await listMarketplace();
    return;
  }
  if (parsed.action === 'add' && parsed.source) {
    await addMarketplace(parsed.source, parsed.scope, parsed.agents);
    p.outro(pc.green('Done!'));
    return;
  }
  if (parsed.action === 'remove' && parsed.name) {
    const { removeTargets } = await import('./remove.ts');
    await removeTargets([
      {
        type: 'plugin',
        name: parsed.name,
        scope: parsed.scope,
        agents: parsed.agents,
        force: true,
      },
    ]);
    p.outro(pc.green('Done!'));
  }
}
