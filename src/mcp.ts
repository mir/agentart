import * as p from '@clack/prompts';
import pc from './colors.ts';
import { homedir } from 'os';
import { sep } from 'path';
import type { AgentType } from './types.ts';
import type { McpServer } from './mcp-types.ts';
import { agents } from './agents.ts';
import { getMcpCapableAgents, mcpAgents } from './mcp-agents.ts';
import {
  installMcpServerForAgent,
  listMcpServersForAgent,
  removeMcpServerForAgent,
} from './mcp-config.ts';
import { addMcpToLock, readMcpLock, removeMcpFromLock } from './mcp-lock.ts';
import { sanitizeName } from './installer.ts';

interface McpOptions {
  global?: boolean;
  agent?: string[];
  yes?: boolean;
  json?: boolean;
  url?: string;
  env?: Record<string, string>;
  header?: Record<string, string>;
}

type McpScope = {
  global: boolean;
  label: 'project' | 'global';
};

type ListedMcpServer = McpServer & {
  agent: AgentType;
  path: string;
  scope: McpScope['label'];
};

function shortenPath(fullPath: string, cwd: string): string {
  const home = homedir();
  if (fullPath === home || fullPath.startsWith(home + sep)) {
    return '~' + fullPath.slice(home.length);
  }
  if (fullPath === cwd || fullPath.startsWith(cwd + sep)) {
    return '.' + fullPath.slice(cwd.length);
  }
  return fullPath;
}

function parseKeyValue(value: string, label: string): [string, string] {
  const idx = value.indexOf('=');
  if (idx <= 0) {
    throw new Error(`${label} must be in KEY=value format`);
  }
  return [value.slice(0, idx), value.slice(idx + 1)];
}

function parseCommonOptions(args: string[]): { positional: string[]; options: McpOptions } {
  const options: McpOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--url') {
      const value = args[++i];
      if (!value) throw new Error('--url requires a value');
      options.url = value;
    } else if (arg === '--env') {
      const value = args[++i];
      if (!value) throw new Error('--env requires KEY=value');
      const [key, envValue] = parseKeyValue(value, '--env');
      options.env = { ...options.env, [key]: envValue };
    } else if (arg === '--header') {
      const value = args[++i];
      if (!value) throw new Error('--header requires KEY=value');
      const [key, headerValue] = parseKeyValue(value, '--header');
      options.header = { ...options.header, [key]: headerValue };
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
        options.agent.push(args[++i]!);
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function splitCommandArgs(args: string[]): { beforeSeparator: string[]; commandArgs: string[] } {
  const separator = args.indexOf('--');
  if (separator === -1) {
    return { beforeSeparator: args, commandArgs: [] };
  }
  return {
    beforeSeparator: args.slice(0, separator),
    commandArgs: args.slice(separator + 1),
  };
}

function validateAgents(input: string[] | undefined, global: boolean | undefined): AgentType[] {
  const valid = getMcpCapableAgents({ global });
  if (!input || input.length === 0) {
    return valid;
  }
  if (input.includes('*')) {
    return valid;
  }
  const invalid = input.filter((agent) => !valid.includes(agent as AgentType));
  if (invalid.length > 0) {
    throw new Error(`Invalid MCP agents: ${invalid.join(', ')}. Valid agents: ${valid.join(', ')}`);
  }
  return input as AgentType[];
}

function getMcpListScopes(options: McpOptions): McpScope[] {
  if (options.global) {
    return [{ global: true, label: 'global' }];
  }
  return [
    { global: false, label: 'project' },
    { global: true, label: 'global' },
  ];
}

function validateAgentsForScopes(input: string[] | undefined, scopes: McpScope[]): AgentType[] {
  const valid = Array.from(
    new Set(scopes.flatMap((scope) => getMcpCapableAgents({ global: scope.global })))
  );
  if (!input || input.length === 0) {
    return valid;
  }
  if (input.includes('*')) {
    return valid;
  }
  const invalid = input.filter((agent) => !valid.includes(agent as AgentType));
  if (invalid.length > 0) {
    throw new Error(`Invalid MCP agents: ${invalid.join(', ')}. Valid agents: ${valid.join(', ')}`);
  }
  return input as AgentType[];
}

export function parseMcpAddArgs(args: string[]): { server: McpServer; options: McpOptions } {
  const { beforeSeparator, commandArgs } = splitCommandArgs(args);
  const { positional, options } = parseCommonOptions(beforeSeparator);
  const rawName = positional[0];
  if (!rawName) {
    throw new Error('Usage: agentart mcp add <name> (--url <url> | -- <command> [args...])');
  }

  const name = sanitizeName(rawName);
  if (options.url) {
    return {
      server: {
        name,
        transport: options.url.startsWith('sse://') ? 'sse' : 'http',
        url: options.url,
        headers: options.header,
      },
      options,
    };
  }

  const command = commandArgs[0] || positional[1];
  const serverArgs = commandArgs.length > 0 ? commandArgs.slice(1) : positional.slice(2);
  if (!command) {
    throw new Error(
      'MCP stdio servers require a command. Use: agentart mcp add <name> -- <command> [args...]'
    );
  }

  return {
    server: {
      name,
      transport: 'stdio',
      command,
      args: serverArgs,
      env: options.env,
    },
    options,
  };
}

async function runMcpAdd(args: string[]): Promise<void> {
  const { server, options } = parseMcpAddArgs(args);
  const targetAgents = validateAgents(options.agent, options.global);
  const cwd = process.cwd();

  const targetLines = targetAgents.map((agent) => {
    const config = mcpAgents[agent]!;
    return `  ${pc.cyan(config.displayName)}`;
  });
  const commandLine =
    server.transport === 'stdio'
      ? `${server.command}${server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}`
      : server.url || '';

  p.note(
    [
      `${pc.cyan(server.name)} ${pc.dim(server.transport)}`,
      `  ${pc.dim(commandLine)}`,
      '',
      ...targetLines,
    ].join('\n'),
    'MCP Install Summary'
  );

  if (!options.yes) {
    const confirmed = await p.confirm({ message: 'Proceed with MCP configuration?' });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('MCP installation cancelled');
      process.exit(0);
    }
  }

  const results = [];
  for (const agent of targetAgents) {
    results.push(await installMcpServerForAgent(server, agent, { global: options.global, cwd }));
  }

  const failed = results.filter((r) => !r.success);
  if (failed.length === 0) {
    await addMcpToLock(
      server,
      {
        source:
          server.transport === 'stdio'
            ? [server.command, ...(server.args || [])].filter(Boolean).join(' ')
            : server.url || server.name,
        sourceType: 'direct',
      },
      { global: options.global, cwd }
    );
  }

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const agent = targetAgents[i]!;
    if (result.success) {
      p.log.success(`${mcpAgents[agent]!.displayName}: ${shortenPath(result.path, cwd)}`);
    } else {
      p.log.error(`${mcpAgents[agent]!.displayName}: ${result.error}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }
  p.outro(pc.green('MCP server configured.'));
}

async function runMcpList(args: string[]): Promise<void> {
  const { options } = parseCommonOptions(args);
  const scopes = getMcpListScopes(options);
  const targetAgents = validateAgentsForScopes(options.agent, scopes);
  const cwd = process.cwd();
  const all: ListedMcpServer[] = (
    await Promise.all(
      scopes.flatMap(({ global, label }) =>
        targetAgents.map(async (agent) => {
          const servers = await listMcpServersForAgent(agent, { global, cwd });
          return servers.map((server): ListedMcpServer => ({ ...server, scope: label }));
        })
      )
    )
  ).flat();

  if (options.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  if (all.length === 0) {
    const scopeLabel = options.global ? 'global' : 'project or global';
    console.log(pc.dim(`No ${scopeLabel} MCP servers found.`));
    return;
  }

  const printServers = (title: string, servers: ListedMcpServer[]) => {
    if (servers.length === 0) return;
    console.log(pc.bold(title));
    console.log();
    for (const server of servers) {
      const details =
        server.transport === 'stdio'
          ? `${server.command}${server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}`
          : server.url || '';
      console.log(`${pc.cyan(server.name)} ${pc.dim(`(${mcpAgents[server.agent]!.displayName})`)}`);
      console.log(`  ${pc.dim(details)}`);
      console.log(`  ${pc.dim(shortenPath(server.path, cwd))}`);
    }
    console.log();
  };

  if (options.global) {
    printServers('Global MCP Servers', all);
  } else {
    printServers(
      'Project MCP Servers',
      all.filter((server) => server.scope === 'project')
    );
    printServers(
      'Global MCP Servers',
      all.filter((server) => server.scope === 'global')
    );
  }
}

async function runMcpRemove(args: string[]): Promise<void> {
  const { positional, options } = parseCommonOptions(args);
  const names = positional.filter((arg) => arg !== '--');
  if (names.length === 0) {
    throw new Error('Usage: agentart mcp remove <server...>');
  }
  const targetAgents = validateAgents(options.agent, options.global);
  const cwd = process.cwd();

  if (!options.yes) {
    p.note(
      names.map((name) => `  ${pc.red(sanitizeName(name))}`).join('\n'),
      'MCP Servers To Remove'
    );
    const confirmed = await p.confirm({
      message: 'Remove these MCP servers from selected agents?',
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('MCP removal cancelled');
      process.exit(0);
    }
  }

  let failCount = 0;
  for (const name of names.map(sanitizeName)) {
    for (const agent of targetAgents) {
      const result = await removeMcpServerForAgent(name, agent, { global: options.global, cwd });
      if (!result.success) {
        failCount++;
        p.log.error(`${mcpAgents[agent]!.displayName}: ${result.error}`);
      }
    }
    await removeMcpFromLock(name, { global: options.global, cwd });
  }

  if (failCount > 0) {
    process.exit(1);
  }
  p.outro(pc.green('MCP server removed.'));
}

async function runMcpLockList(args: string[]): Promise<void> {
  const { options } = parseCommonOptions(args);
  const lock = await readMcpLock({ global: options.global });
  console.log(JSON.stringify(lock, null, 2));
}

export function showMcpHelp(): void {
  console.log(`
Usage: agentart mcp <command> [options]

Commands:
  add <name> -- <command> [args...]     Add a stdio MCP server
  add <name> --url <url>                Add a remote HTTP/SSE MCP server
  list, ls                              List configured project and global MCP servers
  remove, rm <servers...>               Remove MCP servers
  install, restore                       Restore MCP servers from lock
  update, upgrade                        Re-apply locked MCP server config
  lock                                  Print the MCP lock file

Options:
  -g, --global              Use global agent config only
  -a, --agent <agents>      Target specific MCP-capable agents (use '*' for all)
  --env KEY=value           Add an environment variable to a stdio server
  --header KEY=value        Add a header to a remote server
  --json                    Output list as JSON
  -y, --yes                 Skip confirmation prompts

Examples:
  agentart mcp add context7 -- npx -y @upstash/context7-mcp
  agentart mcp add docs --url https://example.com/mcp -a codex cursor -y
  agentart mcp list
  agentart mcp remove context7 -y
  agentart mcp install -y
`);
}

async function runMcpInstallFromLock(args: string[]): Promise<void> {
  const { options } = parseCommonOptions(args);
  const targetAgents = validateAgents(options.agent, options.global);
  const cwd = process.cwd();
  const lock = await readMcpLock({ global: options.global, cwd });
  const entries = Object.values(lock.mcps);

  if (entries.length === 0) {
    console.log(pc.dim(`No ${options.global ? 'global' : 'project'} MCP servers found in lock.`));
    return;
  }

  p.note(
    entries.map((entry) => `  ${pc.cyan(entry.server.name)} ${pc.dim(entry.source)}`).join('\n'),
    'MCP Lock Restore'
  );

  if (!options.yes) {
    const confirmed = await p.confirm({ message: 'Restore these MCP servers to selected agents?' });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('MCP restore cancelled');
      process.exit(0);
    }
  }

  let failCount = 0;
  for (const entry of entries) {
    for (const agent of targetAgents) {
      const result = await installMcpServerForAgent(entry.server, agent, {
        global: options.global,
        cwd,
      });
      if (!result.success) {
        failCount++;
        p.log.error(`${entry.server.name} → ${mcpAgents[agent]!.displayName}: ${result.error}`);
      }
    }
  }

  if (failCount > 0) {
    process.exit(1);
  }
  p.outro(pc.green(`Restored ${entries.length} MCP server(s).`));
}

export async function runMcp(args: string[]): Promise<void> {
  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case 'add':
      case 'a':
        await runMcpAdd(rest);
        break;
      case 'list':
      case 'ls':
        await runMcpList(rest);
        break;
      case 'remove':
      case 'rm':
      case 'r':
        await runMcpRemove(rest);
        break;
      case 'install':
      case 'restore':
      case 'update':
      case 'upgrade':
        await runMcpInstallFromLock(rest);
        break;
      case 'lock':
        await runMcpLockList(rest);
        break;
      case '--help':
      case '-h':
      case undefined:
        showMcpHelp();
        break;
      default:
        throw new Error(`Unknown MCP command: ${command}`);
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
