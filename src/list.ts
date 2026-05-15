import { agents } from './agents.ts';
import { listInstalledHooks, type InstalledHookBundle } from './hooks.ts';
import { listInstalledSkills, type InstalledSkill } from './installer.ts';
import { listMcpServersForAgent } from './mcp-config.ts';
import { getMcpCapableAgents, mcpAgents } from './mcp-agents.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { listCodexMarketplacePlugins } from './plugin-marketplace.ts';
import { readPluginLock } from './plugin-lock.ts';
import type { AgentType } from './types.ts';
import type { McpServer } from './mcp-types.ts';

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

export type InstalledArtifacts = {
  skills: InstalledSkill[];
  mcps: ListedMcpServer[];
  hooks: InstalledHookBundle[];
  plugins: ListedPlugin[];
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

export async function collectInstalledArtifacts(): Promise<InstalledArtifacts> {
  const [
    skills,
    mcps,
    hooks,
    projectCodexPlugins,
    globalCodexPlugins,
    projectPluginLock,
    globalPluginLock,
  ] = await Promise.all([
    listInstalledSkills(),
    listMcpServers(),
    listInstalledHooks(),
    listCodexMarketplacePlugins('project'),
    listCodexMarketplacePlugins('global'),
    readPluginLock({ global: false }),
    readPluginLock({ global: true }),
  ]);
  const claudePlugins: ListedPlugin[] = [
    ...Object.values(projectPluginLock.plugins).flatMap((entry) =>
      entry.agents.includes('claude-code')
        ? [
            {
              name: entry.name,
              agent: 'claude-code' as const,
              scope: 'project' as const,
              source: entry.pluginPath,
            },
          ]
        : []
    ),
    ...Object.values(globalPluginLock.plugins).flatMap((entry) =>
      entry.agents.includes('claude-code')
        ? [
            {
              name: entry.name,
              agent: 'claude-code' as const,
              scope: 'global' as const,
              source: entry.pluginPath,
            },
          ]
        : []
    ),
  ];
  const plugins: ListedPlugin[] = [
    ...projectCodexPlugins.map((plugin) => ({
      name: plugin.name,
      agent: 'codex' as const,
      scope: plugin.scope,
      source: plugin.source.source === 'local' ? plugin.source.path : plugin.source.path,
    })),
    ...globalCodexPlugins.map((plugin) => ({
      name: plugin.name,
      agent: 'codex' as const,
      scope: plugin.scope,
      source: plugin.source.source === 'local' ? plugin.source.path : plugin.source.path,
    })),
    ...claudePlugins,
  ];
  return { skills, mcps, hooks, plugins };
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
  if (skills.length === 0 && mcps.length === 0 && hooks.length === 0 && plugins.length === 0) {
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
    if (
      agentSkills.length === 0 &&
      agentMcps.length === 0 &&
      agentHooks.length === 0 &&
      agentPlugins.length === 0
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
    artifacts.plugins.length === 0
  ) {
    console.log(`${DIM}No skills, MCP servers, hooks, or plugins found.${RESET}`);
    return;
  }

  printScope('project', artifacts);
  printScope('global', artifacts);
}
