import { mkdir, readFile, realpath, writeFile, rm } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import type { AgentType } from '../core/agents.ts';
import type { McpServer, McpTransport } from './mcp-types.ts';
import { getMcpAgentConfig, getMcpConfigPath } from './mcp-agent-support.ts';
function toAgentServer(
  server: McpServer,
  options: { transportKey?: 'transport' | 'type' } = {}
): Record<string, unknown> {
  if (server.transport === 'stdio') {
    return {
      command: server.command,
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      ...(server.enabled === false ? { enabled: false } : {}),
    };
  }
  return {
    [options.transportKey ?? 'transport']: server.transport,
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length > 0
      ? { headers: server.headers }
      : {}),
    ...(server.enabled === false ? { enabled: false } : {}),
  };
}
function fromAgentServer(name: string, raw: unknown): McpServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.command === 'string') {
    return {
      name,
      transport: 'stdio',
      command: value.command,
      args: Array.isArray(value.args)
        ? value.args.filter((a): a is string => typeof a === 'string')
        : undefined,
      env:
        value.env && typeof value.env === 'object' && !Array.isArray(value.env)
          ? Object.fromEntries(
              Object.entries(value.env as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === 'string'
              )
            )
          : undefined,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    };
  }
  if (typeof value.url === 'string') {
    return {
      name,
      transport: value.transport === 'sse' || value.type === 'sse' ? 'sse' : 'http',
      url: value.url,
      headers:
        value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
          ? Object.fromEntries(
              Object.entries(value.headers as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === 'string'
              )
            )
          : undefined,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    };
  }
  return null;
}
function getClaudeStatePath(): string {
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
  return join(home, '.claude.json');
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
async function readClaudeProjectState(cwd: string): Promise<{
  path: string;
  data: Record<string, unknown>;
  project: Record<string, unknown>;
} | null> {
  const path = getClaudeStatePath();
  const data = await readJsonObject(path).catch(() => null);
  if (!data) return null;
  const projects = data.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
  const projectMap = projects as Record<string, unknown>;
  const paths = new Set([resolve(cwd)]);
  const realCwd = await realpath(cwd).catch(() => null);
  if (realCwd) paths.add(realCwd);
  const project = [...paths].map((path) => projectMap[path]).find(Boolean);
  if (!project || typeof project !== 'object' || Array.isArray(project)) return null;
  return { path, data, project: project as Record<string, unknown> };
}
async function listClaudeProjectStateServers(
  cwd: string,
  state?: { path: string; project: Record<string, unknown> } | null
): Promise<Array<McpServer & { agent: AgentType; path: string }>> {
  const projectState = state ?? (await readClaudeProjectState(cwd));
  if (!projectState) return [];
  const container = projectState.project.mcpServers;
  if (!container || typeof container !== 'object' || Array.isArray(container)) return [];
  const disabledNames = new Set(stringArray(projectState.project.disabledMcpServers));
  return Object.entries(container as Record<string, unknown>)
    .map(([name, raw]) => fromAgentServer(name, raw))
    .filter((server): server is McpServer => Boolean(server))
    .map((server) => ({
      ...server,
      enabled: disabledNames.has(server.name) ? false : server.enabled,
      agent: 'claude-code',
      path: projectState.path,
    }));
}
async function removeClaudeProjectStateServer(
  name: string,
  cwd: string
): Promise<{ success: boolean; path: string; removed: boolean; error?: string }> {
  const state = await readClaudeProjectState(cwd);
  if (!state) return { success: true, path: getClaudeStatePath(), removed: false };
  let removed = false;
  const container = state.project.mcpServers;
  if (container && typeof container === 'object' && !Array.isArray(container)) {
    const servers = container as Record<string, unknown>;
    removed = name in servers;
    delete servers[name];
    state.project.mcpServers = servers;
  }
  const disabledServers = stringArray(state.project.disabledMcpServers);
  const nextDisabledServers = disabledServers.filter((serverName) => serverName !== name);
  if (nextDisabledServers.length !== disabledServers.length) {
    state.project.disabledMcpServers = nextDisabledServers;
    removed = true;
  }
  if (!removed) return { success: true, path: state.path, removed: false };
  try {
    await writeJsonObject(state.path, state.data);
    return { success: true, path: state.path, removed: true };
  } catch (error) {
    return {
      success: false,
      path: state.path,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(stripJsonTrailingCommas(stripJsonComments(content)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
}
async function writeJsonObject(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
function stripJsonComments(input: string): string {
  let result = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    const next = input[i + 1];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      result += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i++;
      continue;
    }
    result += char;
  }
  return result;
}
function stripJsonTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}
function tomlQuote(value: string): string {
  return JSON.stringify(value);
}
function encodeTomlServer(name: string, server: McpServer): string {
  const lines = [`[mcp_servers.${tomlQuote(name)}]`];
  if (server.transport === 'stdio') {
    lines.push(`command = ${tomlQuote(server.command || '')}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = [${server.args.map(tomlQuote).join(', ')}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(
        `env = { ${Object.entries(server.env)
          .map(([k, v]) => `${k} = ${tomlQuote(v)}`)
          .join(', ')} }`
      );
    }
  } else {
    lines.push(`transport = ${tomlQuote(server.transport)}`);
    lines.push(`url = ${tomlQuote(server.url || '')}`);
  }
  if (server.enabled === false) lines.push('enabled = false');
  return lines.join('\n') + '\n';
}
function removeCodexServerBlock(content: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[mcp_servers\\.(?:"${escapedName}"|${escapedName})\\]\\s*$`);
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const isSection = /^\[[^\]]+\]\s*$/.test(line);
    if (header.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && isSection) {
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '\n');
}
function parseCodexServers(content: string): McpServer[] {
  const servers: McpServer[] = [];
  const lines = content.split(/\r?\n/);
  let currentName: string | null = null;
  let current: {
    command?: string;
    transport?: McpTransport;
    url?: string;
    args?: string[];
    env?: Record<string, string>;
  } = {};
  const flush = () => {
    if (!currentName) return;
    if (current.command) {
      servers.push({
        name: currentName,
        transport: 'stdio',
        command: current.command,
        args: current.args,
        env: current.env,
      });
    } else if (current.url) {
      servers.push({ name: currentName, transport: current.transport ?? 'http', url: current.url });
    }
  };
  for (const line of lines) {
    const section = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([^\]]+))\]\s*$/);
    if (section) {
      flush();
      currentName = section[1] || section[2] || null;
      current = {};
      continue;
    }
    if (!currentName) continue;
    const kv = line.match(/^\s*(command|transport|url)\s*=\s*"([^"]*)"\s*$/);
    if (kv?.[1] === 'command') current.command = kv[2] || '';
    if (kv?.[1] === 'transport') {
      current.transport = kv[2] === 'sse' ? 'sse' : 'http';
    }
    if (kv?.[1] === 'url') current.url = kv[2] || '';
    const args = line.match(/^\s*args\s*=\s*\[(.*)\]\s*$/);
    if (args) {
      current.args = parseTomlStringArray(args[1] || '');
    }
    const env = line.match(/^\s*env\s*=\s*\{\s*(.*)\s*\}\s*$/);
    if (env) {
      current.env = parseTomlInlineStringTable(env[1] || '');
    }
  }
  flush();
  return servers;
}
function parseTomlStringArray(raw: string): string[] {
  const values: string[] = [];
  const matches = raw.matchAll(/"((?:\\"|[^"])*)"/g);
  for (const match of matches) {
    values.push((match[1] || '').replace(/\\"/g, '"'));
  }
  return values;
}
function parseTomlInlineStringTable(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  const matches = raw.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*"((?:\\"|[^"])*)"/g);
  for (const match of matches) {
    const key = match[1];
    if (!key) continue;
    values[key] = (match[2] || '').replace(/\\"/g, '"');
  }
  return values;
}
export async function installMcpServerForAgent(
  server: McpServer,
  agent: AgentType,
  options: { global?: boolean; cwd?: string } = {}
): Promise<{ success: boolean; path: string; error?: string }> {
  const config = getMcpAgentConfig(agent);
  const path = getMcpConfigPath(agent, options);
  if (!config || !path) {
    return { success: false, path: '', error: 'Agent does not support MCP configuration' };
  }
  try {
    const agentServer = toAgentServer(server, {
      transportKey: agent === 'claude-code' ? 'type' : 'transport',
    });
    if (config.format === 'codexToml') {
      const existing = await readFile(path, 'utf-8').catch(() => '');
      const withoutServer = removeCodexServerBlock(existing, server.name);
      const next = `${withoutServer.trimEnd()}\n\n${encodeTomlServer(server.name, server)}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, next.replace(/^\n+/, ''), 'utf-8');
      return { success: true, path };
    }
    const data = await readJsonObject(path);
    if (config.format === 'vscodeJson') {
      const servers =
        data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers)
          ? (data.servers as Record<string, unknown>)
          : {};
      servers[server.name] = agentServer;
      data.servers = servers;
    } else if (config.format === 'opencodeJson') {
      const mcp =
        data.mcp && typeof data.mcp === 'object' && !Array.isArray(data.mcp)
          ? (data.mcp as Record<string, unknown>)
          : {};
      mcp[server.name] = agentServer;
      data.mcp = mcp;
    } else {
      const mcpServers =
        data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
          ? (data.mcpServers as Record<string, unknown>)
          : {};
      mcpServers[server.name] = agentServer;
      data.mcpServers = mcpServers;
    }
    await writeJsonObject(path, data);
    return { success: true, path };
  } catch (error) {
    return { success: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}
export async function removeMcpServerForAgent(
  name: string,
  agent: AgentType,
  options: { global?: boolean; cwd?: string } = {}
): Promise<{ success: boolean; path: string; removed: boolean; error?: string }> {
  const config = getMcpAgentConfig(agent);
  const path = getMcpConfigPath(agent, options);
  if (!config || !path) {
    return {
      success: false,
      path: '',
      removed: false,
      error: 'Agent does not support MCP configuration',
    };
  }
  try {
    if (config.format === 'codexToml') {
      const existing = await readFile(path, 'utf-8').catch(() => '');
      const next = removeCodexServerBlock(existing, name);
      if (next.trim().length === 0) {
        await rm(path, { force: true });
      } else {
        await writeFile(path, next, 'utf-8');
      }
      return { success: true, path, removed: next !== existing };
    }
    const data: Record<string, unknown> = await readJsonObject(path).catch((error) => {
      if (!options.global && agent === 'claude-code') return {};
      throw error;
    });
    const key =
      config.format === 'vscodeJson'
        ? 'servers'
        : config.format === 'opencodeJson'
          ? 'mcp'
          : 'mcpServers';
    const container = data[key];
    if (!container || typeof container !== 'object' || Array.isArray(container)) {
      if (!options.global && agent === 'claude-code') {
        return await removeClaudeProjectStateServer(name, options.cwd || process.cwd());
      }
      return { success: true, path, removed: false };
    }
    const servers = container as Record<string, unknown>;
    const removed = name in servers;
    delete servers[name];
    data[key] = servers;
    await writeJsonObject(path, data);
    if (!options.global && agent === 'claude-code') {
      const stateResult = await removeClaudeProjectStateServer(name, options.cwd || process.cwd());
      if (!stateResult.success) return stateResult;
      return {
        success: true,
        path: stateResult.removed ? stateResult.path : path,
        removed: removed || stateResult.removed,
      };
    }
    return { success: true, path, removed };
  } catch (error) {
    return {
      success: false,
      path,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
export async function listMcpServersForAgent(
  agent: AgentType,
  options: { global?: boolean; cwd?: string } = {}
): Promise<Array<McpServer & { agent: AgentType; path: string }>> {
  const config = getMcpAgentConfig(agent);
  const path = getMcpConfigPath(agent, options);
  if (!config || !path) return [];
  try {
    const cwd = options.cwd || process.cwd();
    const claudeProjectState =
      !options.global && agent === 'claude-code' ? await readClaudeProjectState(cwd) : null;
    const disabledClaudeProjectServers = new Set(
      stringArray(claudeProjectState?.project.disabledMcpServers)
    );
    const applyClaudeProjectState = (
      server: McpServer & { agent: AgentType; path: string }
    ): McpServer & { agent: AgentType; path: string } =>
      disabledClaudeProjectServers.has(server.name) ? { ...server, enabled: false } : server;
    let servers: Array<McpServer & { agent: AgentType; path: string }>;
    if (config.format === 'codexToml') {
      const content = await readFile(path, 'utf-8');
      servers = parseCodexServers(content).map((server) => ({ ...server, agent, path }));
    } else {
      const data: Record<string, unknown> = await readJsonObject(path).catch((error) => {
        if (!options.global && agent === 'claude-code') return {};
        throw error;
      });
      const key =
        config.format === 'vscodeJson'
          ? 'servers'
          : config.format === 'opencodeJson'
            ? 'mcp'
            : 'mcpServers';
      const container = data[key];
      servers =
        !container || typeof container !== 'object' || Array.isArray(container)
          ? []
          : Object.entries(container as Record<string, unknown>)
              .map(([name, raw]) => fromAgentServer(name, raw))
              .filter((server): server is McpServer => Boolean(server))
              .map((server) => ({ ...server, agent, path }));
    }
    servers = servers.map(applyClaudeProjectState);
    if (!options.global && agent === 'claude-code') {
      const byName = new Map(servers.map((server) => [server.name, server]));
      for (const server of await listClaudeProjectStateServers(cwd, claudeProjectState)) {
        byName.set(server.name, server);
      }
      servers = [...byName.values()];
    }
    return servers;
  } catch {
    return [];
  }
}
