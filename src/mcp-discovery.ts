import { readFile } from 'fs/promises';
import type { McpServer, McpTransport } from './mcp-types.ts';
import {
  normalizeRepoRelativePath,
  repoPathMatchesBasename,
  repoPathMatchesSuffix,
  scanRepoForFilenames,
} from './repo-scan.ts';

const MCP_FILENAMES = [
  '.mcp.json',
  'agentart-mcp-lock.json',
  'opencode.json',
  'opencode.jsonc',
  'mcp.json',
  'settings.json',
  'config.toml',
  'plugin.json',
];

const MCP_BASENAME_TARGETS = new Set([
  '.mcp.json',
  'agentart-mcp-lock.json',
  'opencode.json',
  'opencode.jsonc',
]);

const MCP_SUFFIX_TARGETS = [
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.gemini/settings.json',
  '.codex/config.toml',
  '.claude-plugin/plugin.json',
];

export interface DiscoveredMcpServer extends McpServer {
  sourcePath: string;
}

function isMcpTargetPath(relPath: string): boolean {
  return (
    [...MCP_BASENAME_TARGETS].some((filename) => repoPathMatchesBasename(relPath, filename)) ||
    MCP_SUFFIX_TARGETS.some((suffix) => repoPathMatchesSuffix(relPath, suffix))
  );
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

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonComments(content).replace(/,\s*([}\]])/g, '$1'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fromRawServer(name: string, raw: unknown, sourcePath: string): DiscoveredMcpServer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  if (typeof value.command === 'string') {
    return {
      name,
      transport: 'stdio',
      command: value.command,
      args: Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === 'string')
        : undefined,
      env:
        value.env && typeof value.env === 'object' && !Array.isArray(value.env)
          ? Object.fromEntries(
              Object.entries(value.env as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            )
          : undefined,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
      sourcePath,
    };
  }

  if (typeof value.url === 'string') {
    return {
      name,
      transport: typeof value.transport === 'string' && value.transport === 'sse' ? 'sse' : 'http',
      url: value.url,
      headers:
        value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
          ? Object.fromEntries(
              Object.entries(value.headers as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            )
          : undefined,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
      sourcePath,
    };
  }

  return null;
}

function parseServerMap(
  data: Record<string, unknown>,
  key: 'mcpServers' | 'servers' | 'mcp',
  sourcePath: string
): DiscoveredMcpServer[] {
  const container = data[key];
  if (!container || typeof container !== 'object' || Array.isArray(container)) return [];
  return Object.entries(container as Record<string, unknown>)
    .map(([name, raw]) => fromRawServer(name, raw, sourcePath))
    .filter((server): server is DiscoveredMcpServer => Boolean(server));
}

function parseLock(data: Record<string, unknown>, sourcePath: string): DiscoveredMcpServer[] {
  const mcps = data.mcps;
  if (!mcps || typeof mcps !== 'object' || Array.isArray(mcps)) return [];
  return Object.entries(mcps as Record<string, unknown>)
    .map(([name, raw]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const server = (raw as Record<string, unknown>).server;
      return fromRawServer(name, server, sourcePath);
    })
    .filter((server): server is DiscoveredMcpServer => Boolean(server));
}

function parseCodexToml(content: string, sourcePath: string): DiscoveredMcpServer[] {
  const servers: DiscoveredMcpServer[] = [];
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
        sourcePath,
      });
    } else if (current.url) {
      servers.push({
        name: currentName,
        transport: current.transport ?? 'http',
        url: current.url,
        sourcePath,
      });
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
      current.args = [...(args[1] || '').matchAll(/"((?:\\"|[^"])*)"/g)].map((match) =>
        (match[1] || '').replace(/\\"/g, '"')
      );
    }
    const env = line.match(/^\s*env\s*=\s*\{\s*(.*)\s*\}\s*$/);
    if (env) {
      current.env = Object.fromEntries(
        [...(env[1] || '').matchAll(/([A-Za-z0-9_.-]+)\s*=\s*"((?:\\"|[^"])*)"/g)].map((match) => [
          match[1]!,
          (match[2] || '').replace(/\\"/g, '"'),
        ])
      );
    }
  }
  flush();
  return servers;
}

async function parseMcpFile(path: string, relPath: string): Promise<DiscoveredMcpServer[]> {
  const content = await readFile(path, 'utf-8').catch(() => null);
  if (content === null) return [];

  if (repoPathMatchesSuffix(relPath, '.codex/config.toml')) {
    return parseCodexToml(content, relPath);
  }

  const data = parseJsonObject(content);
  if (!data) return [];

  if (repoPathMatchesBasename(relPath, 'agentart-mcp-lock.json')) return parseLock(data, relPath);
  if (repoPathMatchesSuffix(relPath, '.vscode/mcp.json')) {
    return parseServerMap(data, 'servers', relPath);
  }
  if (
    repoPathMatchesBasename(relPath, 'opencode.json') ||
    repoPathMatchesBasename(relPath, 'opencode.jsonc')
  ) {
    return parseServerMap(data, 'mcp', relPath);
  }

  return parseServerMap(data, 'mcpServers', relPath);
}

export async function discoverMcpServers(basePath: string): Promise<DiscoveredMcpServer[]> {
  const candidates = await scanRepoForFilenames(basePath, MCP_FILENAMES);
  const results: DiscoveredMcpServer[] = [];
  const seen = new Set<string>();

  for (const path of candidates) {
    const relPath = normalizeRepoRelativePath(path.slice(basePath.length + 1));
    if (!isMcpTargetPath(relPath)) continue;

    const parsed = await parseMcpFile(path, relPath);
    for (const server of parsed) {
      const key = `${server.sourcePath}:${server.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(server);
    }
  }

  return results.sort((a, b) => {
    const sourceDiff = a.sourcePath.localeCompare(b.sourcePath);
    if (sourceDiff !== 0) return sourceDiff;
    return a.name.localeCompare(b.name);
  });
}
