import { agents } from '../core/agents.ts';
import { listInstalledHooks, type InstalledHookBundle } from '../artifacts/hooks.ts';
import { listInstalledSkills, type InstalledSkill } from '../artifacts/skills.ts';
import { listMcpServersForAgent } from '../artifacts/mcp.ts';
import { getMcpCapableAgents, mcpAgents } from '../artifacts/mcp.ts';
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
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[38;5;102m';
const CYAN = '\x1b[36m';
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
export type ListedMarketplace = {
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
  marketplaces: ListedMarketplace[];
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
  const marketplaces: ListedMarketplace[] = [
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
    (marketplace, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.agent === marketplace.agent &&
          candidate.scope === marketplace.scope &&
          candidate.name === marketplace.name
      ) === index
  );
  return { skills, mcps, hooks, plugins, marketplaces };
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
  return `${target}${server.enabled === false ? ' (disabled)' : ''}`.trim();
}
function printScope(scope: Scope, artifacts: InstalledArtifacts): void {
  const title = scope === 'project' ? 'Project' : 'Global';
  const skills = artifacts.skills.filter((skill) => skill.scope === scope);
  const mcps = artifacts.mcps.filter((server) => server.scope === scope);
  const hooks = artifacts.hooks.filter((hook) => hook.scope === scope);
  const plugins = artifacts.plugins.filter((plugin) => plugin.scope === scope);
  const marketplaces = artifacts.marketplaces.filter((marketplace) => marketplace.scope === scope);
  if (
    skills.length === 0 &&
    mcps.length === 0 &&
    hooks.length === 0 &&
    plugins.length === 0 &&
    marketplaces.length === 0
  ) {
    return;
  }
  console.log(`${BOLD}${title}${RESET}`);
  const sharedSkills = skills.filter((skill) => skill.agents.length === 0);
  if (sharedSkills.length > 0) {
    console.log(`  ${BOLD}Shared${RESET}`);
    console.log(`    ${DIM}Skills${RESET}`);
    for (const skill of sharedSkills) {
      console.log(`      ${CYAN}${sanitizeMetadata(skill.name)}${RESET}`);
    }
  }
  for (const agent of Object.keys(agents) as AgentType[]) {
    const agentSkills = skills.filter((skill) => skill.agents.includes(agent));
    const agentMcps = mcps.filter((server) => server.agent === agent);
    const agentHooks = hooks.filter((hook) => hook.agent === agent);
    const agentPlugins = plugins.filter((plugin) => plugin.agent === agent);
    const agentMarketplaces = marketplaces.filter((marketplace) => marketplace.agent === agent);
    if (
      agentSkills.length === 0 &&
      agentMcps.length === 0 &&
      agentHooks.length === 0 &&
      agentPlugins.length === 0 &&
      agentMarketplaces.length === 0
    ) {
      continue;
    }
    console.log(`  ${BOLD}${mcpAgents[agent]?.displayName ?? agents[agent].displayName}${RESET}`);
    if (agentSkills.length > 0) {
      console.log(`    ${DIM}Skills${RESET}`);
      for (const skill of agentSkills) {
        console.log(`      ${CYAN}${sanitizeMetadata(skill.name)}${RESET}`);
      }
    }
    if (agentMcps.length > 0) {
      console.log(`    ${DIM}MCPs${RESET}`);
      for (const server of agentMcps) {
        console.log(
          `      ${CYAN}${sanitizeMetadata(server.name)}${RESET} ${DIM}${formatMcp(server)}${RESET}`
        );
      }
    }
    if (agentHooks.length > 0) {
      console.log(`    ${DIM}Hooks${RESET}`);
      for (const hook of agentHooks) {
        console.log(
          `      ${CYAN}${sanitizeMetadata(hook.name)}${RESET} ${DIM}${hook.events.map(sanitizeMetadata).join(', ')}${RESET}`
        );
      }
    }
    if (agentPlugins.length > 0) {
      console.log(`    ${DIM}Plugins${RESET}`);
      for (const plugin of agentPlugins) {
        console.log(
          `      ${CYAN}${sanitizeMetadata(plugin.name)}${RESET} ${DIM}${sanitizeMetadata(plugin.source)}${RESET}`
        );
      }
    }
    if (agentMarketplaces.length > 0) {
      console.log(`    ${DIM}Marketplaces${RESET}`);
      for (const marketplace of agentMarketplaces) {
        console.log(
          `      ${CYAN}${sanitizeMetadata(marketplace.name)}${RESET} ${DIM}${sanitizeMetadata(marketplace.source)}${RESET}`
        );
      }
    }
  }
  console.log();
}
export async function runList(args: string[]): Promise<void> {
  if (args.length > 0) {
    throw new Error('Usage: sloprider list');
  }
  const artifacts = await collectInstalledArtifacts();
  if (
    artifacts.skills.length === 0 &&
    artifacts.mcps.length === 0 &&
    artifacts.hooks.length === 0 &&
    artifacts.plugins.length === 0 &&
    artifacts.marketplaces.length === 0
  ) {
    console.log(`${DIM}No skills, MCP servers, hooks, or plugins found.${RESET}`);
    return;
  }
  printScope('project', artifacts);
  printScope('global', artifacts);
}
