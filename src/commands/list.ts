import YAML from 'yaml';
import { dirname, relative } from 'path';
import { homedir } from 'os';
import { agents } from '../core/agents.ts';
import { listInstalledHooks, type InstalledHookBundle } from '../artifacts/hooks.ts';
import { listInstalledSkills, type InstalledSkill } from '../artifacts/skills.ts';
import { listMcpServersForAgent } from '../artifacts/mcp.ts';
import { getMcpCapableAgents } from '../artifacts/mcp.ts';
import { sanitizeMetadata } from '../util/sanitize.ts';
import { listCodexMarketplacePlugins } from '../artifacts/plugins.ts';
import {
  listClaudeInstalledPlugins,
  splitClaudePluginId,
  type ClaudeInstalledPlugin,
} from '../artifacts/plugins.ts';
import {
  readPluginRegistry,
  writePluginRegistry,
  type PluginRegistryFile,
} from '../artifacts/plugins.ts';
import type { AgentType } from '../core/agents.ts';
import type { PluginLocator } from '../core/artifacts.ts';
import type { McpServer } from '../artifacts/mcp.ts';
export type Scope = 'project' | 'global';
export type ListedMcpServer = McpServer & {
  agent: AgentType;
  path: string;
  scope: Scope;
};
export type ListedPlugin = {
  name: string;
  agent: Extract<AgentType, 'codex' | 'claude-code'>;
  scope: Scope;
  source: string;
};
export type ListedMarketplaceEntry = {
  name: string;
  agent: Extract<AgentType, 'codex' | 'claude-code'>;
  scope: Scope;
  source: string;
};
export type InstalledArtifacts = {
  skills: InstalledSkill[];
  mcps: ListedMcpServer[];
  hooks: InstalledHookBundle[];
  plugins: ListedPlugin[];
  marketplaceEntries: ListedMarketplaceEntry[];
};
type ListedYaml = Partial<Record<Scope, ScopeYaml>>;
type ScopeYaml = {
  skills?: SkillYaml[];
  mcps?: McpYaml[];
  hooks?: HookYaml[];
  plugins?: PluginYaml[];
  marketplace_entries?: MarketplaceEntryYaml[];
};
type SkillYaml = {
  name: string;
  agents: AgentType[];
  location: string;
};
type McpYaml = {
  name: string;
  agents: AgentType[];
  target: string;
};
type HookYaml = {
  name: string;
  agents: AgentType[];
  events: string[];
};
type PluginYaml = {
  name: string;
  agents: AgentType[];
  source: string;
};
type MarketplaceEntryYaml = {
  name: string;
  agents: AgentType[];
  source: string;
};
export function parseListOptions(args: string[]): Record<string, never> {
  if (args.length > 0) throw new Error('Usage: sloprider list');
  return {};
}
export async function listMcpServers(): Promise<ListedMcpServer[]> {
  const scopes = [
    { global: false, scope: 'project' as const },
    { global: true, scope: 'global' as const },
  ];
  const nested = await Promise.all(
    scopes.flatMap(({ global, scope }) =>
      getMcpCapableAgents({ global }).map(async (agent) =>
        (await listMcpServersForAgent(agent, { global })).map((server) => ({
          ...server,
          scope,
        }))
      )
    )
  );
  return nested.flat();
}
async function syncClaudePluginsToRegistry(
  registry: PluginRegistryFile,
  plugins: ClaudeInstalledPlugin[],
  scope: Scope
): Promise<PluginRegistryFile> {
  let changed = false;
  const now = new Date().toISOString();
  const next: PluginRegistryFile = {
    version: registry.version,
    plugins: { ...registry.plugins },
  };
  function findManagedMarketplaceKey(plugin: ClaudeInstalledPlugin): string | undefined {
    const parsed = splitClaudePluginId(plugin.id);
    if (!parsed.marketplaceName) return undefined;
    return Object.entries(next.plugins).find(
      ([, entry]) =>
        entry.name === parsed.name &&
        entry.marketplaceName === parsed.marketplaceName &&
        entry.agents.includes('claude-code')
    )?.[0];
  }
  for (const plugin of plugins.filter((candidate) => candidate.scope === scope)) {
    const managedMarketplaceKey = findManagedMarketplaceKey(plugin);
    if (managedMarketplaceKey && managedMarketplaceKey !== plugin.id && next.plugins[plugin.id]) {
      delete next.plugins[plugin.id];
      changed = true;
    }
    const existingKey = managedMarketplaceKey ?? (next.plugins[plugin.id] ? plugin.id : undefined);
    const existing = existingKey ? next.plugins[existingKey] : undefined;
    if (existing) {
      if (!existing.agents.includes('claude-code')) {
        next.plugins[existingKey!] = {
          ...existing,
          agents: [...existing.agents, 'claude-code'],
          updatedAt: now,
        };
        changed = true;
      }
      continue;
    }
    next.plugins[plugin.id] = {
      name: plugin.id,
      agents: ['claude-code'],
      scope,
      source: plugin.id,
      sourceType: 'claude-plugin',
      ref: plugin.version === 'unknown' ? undefined : plugin.version,
      rootPath: plugin.installPath ?? plugin.id,
      installedPath: plugin.installPath,
      locator: { source: 'local', path: plugin.installPath ?? plugin.id },
      installedAt: now,
      updatedAt: now,
    };
    changed = true;
  }
  if (changed) await writePluginRegistry(next, { global: scope === 'global' });
  return next;
}
export async function collectInstalledArtifacts(): Promise<InstalledArtifacts> {
  const [
    skills,
    mcps,
    hooks,
    projectCodexPlugins,
    globalCodexPlugins,
    installedClaudePlugins,
    projectPluginRegistry,
    globalPluginRegistry,
  ] = await Promise.all([
    listInstalledSkills(),
    listMcpServers(),
    listInstalledHooks(),
    listCodexMarketplacePlugins('project'),
    listCodexMarketplacePlugins('global'),
    listClaudeInstalledPlugins(),
    readPluginRegistry({ global: false }),
    readPluginRegistry({ global: true }),
  ]);
  const [syncedProjectPluginRegistry, syncedGlobalPluginRegistry] = await Promise.all([
    syncClaudePluginsToRegistry(projectPluginRegistry, installedClaudePlugins, 'project'),
    syncClaudePluginsToRegistry(globalPluginRegistry, installedClaudePlugins, 'global'),
  ]);
  const claudePlugins: ListedPlugin[] = [
    ...Object.values(syncedProjectPluginRegistry.plugins).flatMap((entry) =>
      entry.agents.includes('claude-code')
        ? [
            {
              name: entry.name,
              agent: 'claude-code' as const,
              scope: 'project' as const,
              source: entry.rootPath,
            },
          ]
        : []
    ),
    ...Object.values(syncedGlobalPluginRegistry.plugins).flatMap((entry) =>
      entry.agents.includes('claude-code')
        ? [
            {
              name: entry.name,
              agent: 'claude-code' as const,
              scope: 'global' as const,
              source: entry.rootPath,
            },
          ]
        : []
    ),
  ];
  const plugins: ListedPlugin[] = [...claudePlugins].filter(
    (plugin, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.agent === plugin.agent &&
          candidate.scope === plugin.scope &&
          candidate.name === plugin.name
      ) === index
  );
  const marketplaceEntries: ListedMarketplaceEntry[] = [
    ...projectCodexPlugins.map((plugin) => ({
      name: plugin.name,
      agent: 'codex' as const,
      scope: plugin.scope,
      source: formatPluginLocator(plugin.source),
    })),
    ...globalCodexPlugins.map((plugin) => ({
      name: plugin.name,
      agent: 'codex' as const,
      scope: plugin.scope,
      source: formatPluginLocator(plugin.source),
    })),
  ].filter(
    (marketplaceEntry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.agent === marketplaceEntry.agent &&
          candidate.scope === marketplaceEntry.scope &&
          candidate.name === marketplaceEntry.name
      ) === index
  );
  return { skills, mcps, hooks, plugins, marketplaceEntries };
}
function formatPluginLocator(locator: PluginLocator): string {
  if (locator.source === 'local') return locator.path;
  const source = locator.ref ? `${locator.url}#${locator.ref}` : locator.url;
  const path = locator.path.replace(/^\.\//, '');
  if (!path || path === '.') return source;
  return `${source} ${path}`;
}
function formatMcp(server: ListedMcpServer): string {
  let target: string;
  if (server.transport === 'stdio') {
    target = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
  } else {
    target = server.url ?? '';
  }
  const formatted = `${server.transport}: ${target}`.trim();
  return `${formatted}${server.enabled === false ? ' (disabled)' : ''}`.trim();
}
function buildInstalledYaml(artifacts: InstalledArtifacts): ListedYaml {
  const output: ListedYaml = {};
  for (const scope of ['project', 'global'] as const) {
    const skills = buildSkillYaml(artifacts.skills.filter((skill) => skill.scope === scope));
    const mcps = buildMcpYaml(artifacts.mcps.filter((server) => server.scope === scope));
    const hooks = buildHookYaml(artifacts.hooks.filter((hook) => hook.scope === scope));
    const plugins = buildPluginYaml(artifacts.plugins.filter((plugin) => plugin.scope === scope));
    const marketplace_entries = buildMarketplaceEntryYaml(
      artifacts.marketplaceEntries.filter((entry) => entry.scope === scope)
    );
    const scopeYaml: ScopeYaml = {
      skills: emptyToUndefined(skills),
      mcps: emptyToUndefined(mcps),
      hooks: emptyToUndefined(hooks),
      plugins: emptyToUndefined(plugins),
      marketplace_entries: emptyToUndefined(marketplace_entries),
    };
    if (Object.values(scopeYaml).some(Boolean)) {
      output[scope] = scopeYaml;
    }
  }
  return output;
}
function buildSkillYaml(skills: InstalledSkill[]): SkillYaml[] {
  const groups = new Map<string, SkillYaml>();
  for (const skill of skills) {
    const name = sanitizeMetadata(skill.name);
    const location = sanitizeMetadata(formatSkillLocation(skill.path));
    const key = `${skill.scope}\0${name}\0${skill.canonicalPath || skill.path}`;
    const item = groups.get(key) ?? { name, agents: [], location };
    for (const agent of skill.agents) addAgent(item.agents, agent);
    groups.set(key, item);
  }
  return sortByNameAndDetail(Array.from(groups.values()), (item) => item.location);
}
function buildMcpYaml(servers: ListedMcpServer[]): McpYaml[] {
  const groups = new Map<string, McpYaml>();
  for (const server of servers) {
    const name = sanitizeMetadata(server.name);
    const target = sanitizeMetadata(formatMcp(server));
    const key = `${server.scope}\0${name}\0${target}`;
    const item = groups.get(key) ?? { name, agents: [], target };
    addAgent(item.agents, server.agent);
    groups.set(key, item);
  }
  return sortByNameAndDetail(Array.from(groups.values()), (item) => item.target);
}
function buildHookYaml(hooks: InstalledHookBundle[]): HookYaml[] {
  const groups = new Map<string, HookYaml>();
  for (const hook of hooks) {
    const name = sanitizeMetadata(hook.name);
    const events = hook.events.map(sanitizeMetadata);
    const key = `${hook.scope}\0${name}\0${hook.agent}\0${events.join('\0')}`;
    const item = groups.get(key) ?? { name, agents: [], events };
    addAgent(item.agents, hook.agent);
    groups.set(key, item);
  }
  return sortByNameAndDetail(Array.from(groups.values()), (item) => item.events.join('\0'));
}
function buildPluginYaml(plugins: ListedPlugin[]): PluginYaml[] {
  const groups = new Map<string, PluginYaml>();
  for (const plugin of plugins) {
    const name = sanitizeMetadata(plugin.name);
    const source = sanitizeMetadata(plugin.source);
    const key = `${plugin.scope}\0${name}\0${source}`;
    const item = groups.get(key) ?? { name, agents: [], source };
    addAgent(item.agents, plugin.agent);
    groups.set(key, item);
  }
  return sortByNameAndDetail(Array.from(groups.values()), (item) => item.source);
}
function buildMarketplaceEntryYaml(entries: ListedMarketplaceEntry[]): MarketplaceEntryYaml[] {
  const groups = new Map<string, MarketplaceEntryYaml>();
  for (const entry of entries) {
    const name = sanitizeMetadata(entry.name);
    const source = sanitizeMetadata(entry.source);
    const key = `${entry.scope}\0${name}\0${source}`;
    const item = groups.get(key) ?? { name, agents: [], source };
    addAgent(item.agents, entry.agent);
    groups.set(key, item);
  }
  return sortByNameAndDetail(Array.from(groups.values()), (item) => item.source);
}
function addAgent(list: AgentType[], agent: AgentType): void {
  if (!list.includes(agent)) list.push(agent);
  const order = Object.keys(agents) as AgentType[];
  list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function emptyToUndefined<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}
function sortByNameAndDetail<T extends { name: string }>(
  items: T[],
  detail: (item: T) => string
): T[] {
  return items.sort((a, b) => a.name.localeCompare(b.name) || detail(a).localeCompare(detail(b)));
}
function formatSkillLocation(path: string): string {
  return formatPath(dirname(path));
}
function formatPath(path: string): string {
  const cwd = process.cwd();
  const projectRelative = relative(cwd, path);
  if (projectRelative && !projectRelative.startsWith('..') && !projectRelative.startsWith('/')) {
    return projectRelative;
  }
  const home = homedir();
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}
export async function runList(args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new Error('Usage: sloprider list');
  }
  const artifacts = await collectInstalledArtifacts();
  const output = buildInstalledYaml(artifacts);
  console.log(YAML.stringify(output, { lineWidth: 0 }));
}
