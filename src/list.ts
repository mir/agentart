import { homedir } from 'os';
import type { AgentType } from './types.ts';
import { agents } from './agents.ts';
import { listInstalledSkills, type InstalledSkill } from './installer.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { getAllLockedSkills } from './skill-lock.ts';
import { listMcpServersForAgent } from './mcp-config.ts';
import { getMcpCapableAgents, mcpAgents } from './mcp-agents.ts';
import type { McpServer } from './mcp-types.ts';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[38;5;102m';
const TEXT = '\x1b[38;5;145m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

interface ListOptions {
  global?: boolean;
  all?: boolean;
  agent?: string[];
  json?: boolean;
}

type ListedMcpServer = McpServer & {
  agent: AgentType;
  path: string;
  scope: 'project' | 'global';
};

/**
 * Shortens a path for display: replaces homedir with ~ and cwd with .
 */
function shortenPath(fullPath: string, cwd: string): string {
  const home = homedir();
  if (fullPath.startsWith(home)) {
    return fullPath.replace(home, '~');
  }
  if (fullPath.startsWith(cwd)) {
    return '.' + fullPath.slice(cwd.length);
  }
  return fullPath;
}

/**
 * Formats a list of items, truncating if too many
 */
function formatList(items: string[], maxShow: number = 5): string {
  if (items.length <= maxShow) {
    return items.join(', ');
  }
  const shown = items.slice(0, maxShow);
  const remaining = items.length - maxShow;
  return `${shown.join(', ')} +${remaining} more`;
}

export function parseListOptions(args: string[]): ListOptions {
  const options: ListOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      // Collect all following arguments until next flag
      while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        options.agent.push(args[++i]!);
      }
    }
  }

  return options;
}

async function listMcpServers(
  options: { all?: boolean; global?: boolean; agentFilter?: AgentType[] } = {}
): Promise<ListedMcpServer[]> {
  const scopes =
    options.all === true
      ? [
          { global: false, scope: 'project' as const },
          { global: true, scope: 'global' as const },
        ]
      : [
          {
            global: options.global === true,
            scope: options.global ? ('global' as const) : ('project' as const),
          },
        ];

  const results = await Promise.all(
    scopes.flatMap(({ global, scope }) => {
      const capableAgents = getMcpCapableAgents({ global });
      const targetAgents = options.agentFilter
        ? capableAgents.filter((agent) => options.agentFilter!.includes(agent))
        : capableAgents;

      return targetAgents.map(async (agent) => {
        const servers = await listMcpServersForAgent(agent, { global, cwd: process.cwd() });
        return servers.map((server) => ({ ...server, scope }));
      });
    })
  );

  return results.flat();
}

export async function runList(args: string[]): Promise<void> {
  const options = parseListOptions(args);

  // Default to project only (local), use -g for global, --all for both scopes.
  const scope = options.all === true ? undefined : options.global === true ? true : false;

  // Validate agent filter if provided
  let agentFilter: AgentType[] | undefined;
  if (options.agent && options.agent.length > 0) {
    const validAgents = Object.keys(agents);
    const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

    if (invalidAgents.length > 0) {
      console.log(`${YELLOW}Invalid agents: ${invalidAgents.join(', ')}${RESET}`);
      console.log(`${DIM}Valid agents: ${validAgents.join(', ')}${RESET}`);
      process.exit(1);
    }

    agentFilter = options.agent as AgentType[];
  }

  const installedSkills = await listInstalledSkills({
    global: scope,
    agentFilter,
  });
  const installedMcps = options.all ? await listMcpServers({ all: true, agentFilter }) : [];

  // JSON output mode: structured, no ANSI, untruncated agent lists
  if (options.json) {
    const jsonOutput = installedSkills.map((skill) => ({
      name: skill.name,
      path: skill.canonicalPath,
      scope: skill.scope,
      agents: skill.agents.map((a) => agents[a].displayName),
    }));
    if (options.all) {
      console.log(
        JSON.stringify(
          {
            skills: jsonOutput,
            mcps: installedMcps.map((server) => ({
              name: server.name,
              transport: server.transport,
              command: server.command,
              args: server.args,
              url: server.url,
              enabled: server.enabled,
              path: server.path,
              scope: server.scope,
              agent: mcpAgents[server.agent]?.displayName ?? agents[server.agent].displayName,
            })),
          },
          null,
          2
        )
      );
    } else {
      console.log(JSON.stringify(jsonOutput, null, 2));
    }
    return;
  }

  // Fetch lock entries to get plugin grouping info
  const lockedSkills = await getAllLockedSkills();

  const cwd = process.cwd();
  const scopeLabel = scope === undefined ? 'All' : scope ? 'Global' : 'Project';

  if (installedSkills.length === 0 && installedMcps.length === 0) {
    if (options.json) {
      console.log('[]');
      return;
    }
    if (options.all) {
      console.log(`${DIM}No skills or MCP servers found.${RESET}`);
    } else {
      console.log(`${DIM}No ${scopeLabel.toLowerCase()} skills found.${RESET}`);
    }
    if (scope) {
      console.log(`${DIM}Try listing project skills without -g${RESET}`);
    } else if (!options.all) {
      console.log(`${DIM}Try listing global skills with -g${RESET}`);
    }
    return;
  }

  function printSkill(skill: InstalledSkill, indent: boolean = false): void {
    const prefix = indent ? '  ' : '';
    const shortPath = shortenPath(skill.canonicalPath, cwd);
    const agentNames = skill.agents.map((a) => agents[a].displayName);
    const agentInfo =
      skill.agents.length > 0 ? formatList(agentNames) : `${YELLOW}not linked${RESET}`;
    console.log(
      `${prefix}${CYAN}${sanitizeMetadata(skill.name)}${RESET} ${DIM}${shortPath}${RESET}`
    );
    console.log(`${prefix}  ${DIM}Agents:${RESET} ${agentInfo}`);
  }

  function formatMcpDetails(server: ListedMcpServer): string {
    if (server.transport === 'stdio') {
      return `${server.command}${server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}`;
    }
    return server.url || '';
  }

  function printSkillsSection(title: string, skills: InstalledSkill[]): void {
    if (skills.length === 0) return;
    console.log(`${BOLD}${title}${RESET}`);
    console.log();

    // Group skills by plugin
    const groupedSkills: Record<string, InstalledSkill[]> = {};
    const ungroupedSkills: InstalledSkill[] = [];

    for (const skill of skills) {
      const lockEntry = lockedSkills[skill.name];
      if (lockEntry?.pluginName) {
        const group = lockEntry.pluginName;
        if (!groupedSkills[group]) {
          groupedSkills[group] = [];
        }
        groupedSkills[group].push(skill);
      } else {
        ungroupedSkills.push(skill);
      }
    }

    const hasGroups = Object.keys(groupedSkills).length > 0;

    if (hasGroups) {
      // Print groups sorted alphabetically
      const sortedGroups = Object.keys(groupedSkills).sort();
      for (const group of sortedGroups) {
        // Convert kebab-case to Title Case for display header
        const groupTitle = group
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');

        console.log(`${BOLD}${groupTitle}${RESET}`);
        const grouped = groupedSkills[group];
        if (grouped) {
          for (const skill of grouped) {
            printSkill(skill, true);
          }
        }
        console.log();
      }

      // Print ungrouped skills if any exist
      if (ungroupedSkills.length > 0) {
        console.log(`${BOLD}General${RESET}`);
        for (const skill of ungroupedSkills) {
          printSkill(skill, true);
        }
        console.log();
      }
    } else {
      // No groups, print flat list as before
      for (const skill of skills) {
        printSkill(skill);
      }
      console.log();
    }
  }

  function printMcpSection(title: string, servers: ListedMcpServer[]): void {
    if (servers.length === 0) return;
    console.log(`${BOLD}${title}${RESET}`);
    console.log();
    for (const server of servers) {
      const agentName = mcpAgents[server.agent]?.displayName ?? agents[server.agent].displayName;
      console.log(`${CYAN}${sanitizeMetadata(server.name)}${RESET} ${DIM}(${agentName})${RESET}`);
      console.log(`  ${DIM}${formatMcpDetails(server)}${RESET}`);
      console.log(`  ${DIM}${shortenPath(server.path, cwd)}${RESET}`);
    }
    console.log();
  }

  if (options.all) {
    printSkillsSection(
      'Project Skills',
      installedSkills.filter((skill) => skill.scope === 'project')
    );
    printSkillsSection(
      'Global Skills',
      installedSkills.filter((skill) => skill.scope === 'global')
    );
    printMcpSection(
      'Project MCP Servers',
      installedMcps.filter((server) => server.scope === 'project')
    );
    printMcpSection(
      'Global MCP Servers',
      installedMcps.filter((server) => server.scope === 'global')
    );
  } else {
    printSkillsSection(`${scopeLabel} Skills`, installedSkills);
  }
}
