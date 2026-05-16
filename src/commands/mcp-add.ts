import * as p from '@clack/prompts';
import pc from '../ui/colors.ts';
import { agents } from '../core/agents.ts';
import { getMcpCapableAgents, mcpAgents } from '../artifacts/mcp.ts';
import { installMcpServerForAgent } from '../artifacts/mcp.ts';
import { addMcpToLock } from '../artifacts/mcp.ts';
import type { McpInstallResult, McpServer } from '../artifacts/mcp.ts';
import type { AgentType } from '../core/agents.ts';
import { parseScope, type InstallScope } from '../core/scope.ts';
export const MCP_ADD_USAGE =
  'Usage: sloprider mcp add <url> [--name <name>] [--scope project|global] [--agents all|agent[,agent...]]';
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const OK_STATUS_CODES = new Set([401, 403, 405]);
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};
type Scope = InstallScope;
type AgentSelection = { all: true; agents: AgentType[] } | { all: false; agents: AgentType[] };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ParsedMcpAddArgs = {
  inputUrl: string;
  name?: string;
  scope: Scope;
  agents: AgentSelection;
};
export type ProbeAttempt = {
  url: string;
  success: boolean;
  result: string;
  workingUrl?: string;
};
export type ProbeResult = {
  workingUrl?: string;
  attempts: ProbeAttempt[];
};
export type McpAddInstallResult = {
  server: McpServer;
  scope: Scope;
  agents: AgentType[];
  results: McpInstallResult[];
};
function isCancel(value: unknown): value is symbol {
  return typeof value === 'symbol';
}
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function parseAgentSelection(value: string | undefined): AgentSelection {
  if (!value || value === 'all') return { all: true, agents: [] };
  const selected = splitList(value);
  if (selected.length === 0) throw new Error('--agents must name at least one agent or all');
  const knownAgents = new Set(Object.keys(agents));
  const invalid = selected.filter((agent) => !knownAgents.has(agent));
  if (invalid.length > 0) {
    throw new Error(`Unknown agent(s): ${invalid.join(', ')}`);
  }
  return { all: false, agents: selected as AgentType[] };
}
function parseMcpAddArgs(args: string[]): ParsedMcpAddArgs {
  const [mcpCommand, inputUrl, ...rest] = args;
  if (mcpCommand !== 'add' || !inputUrl || inputUrl.startsWith('-')) {
    throw new Error(MCP_ADD_USAGE);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const name = rawName ?? '';
    const value = inlineValue ?? rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    if (!['name', 'scope', 'agents'].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
    flags.set(name, value);
  }
  return {
    inputUrl,
    name: flags.get('name')?.trim() || undefined,
    scope: parseScope(flags.get('scope') ?? 'project'),
    agents: parseAgentSelection(flags.get('agents')),
  };
}
function hasScheme(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
}
function candidateKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/') {
      return `${parsed.protocol}//${parsed.host}${parsed.search}`;
    }
  } catch {
    return url;
  }
  return url;
}
function appendCandidate(candidates: string[], seen: Set<string>, value: string): void {
  const key = candidateKey(value);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(value);
}
function mcpVariant(candidate: string, trailingSlash: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const pathWithoutTrailingSlash = parsed.pathname.replace(/\/+$/g, '');
  const mcpPath =
    pathWithoutTrailingSlash === '/mcp' || pathWithoutTrailingSlash.endsWith('/mcp')
      ? pathWithoutTrailingSlash
      : `${pathWithoutTrailingSlash}/mcp`;
  const path = `${mcpPath || '/mcp'}${trailingSlash ? '/' : ''}`;
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}
function addMcpVariants(candidates: string[], seen: Set<string>, candidate: string): void {
  for (const trailingSlash of [false, true]) {
    const variant = mcpVariant(candidate, trailingSlash);
    if (variant) appendCandidate(candidates, seen, variant);
  }
}
export function buildMcpUrlCandidates(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  if (hasScheme(trimmed)) {
    appendCandidate(candidates, seen, trimmed);
    addMcpVariants(candidates, seen, trimmed);
    return candidates;
  }
  const https = `https://${trimmed}`;
  const http = `http://${trimmed}`;
  appendCandidate(candidates, seen, https);
  appendCandidate(candidates, seen, http);
  addMcpVariants(candidates, seen, https);
  addMcpVariants(candidates, seen, http);
  return candidates;
}
function validateHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
export function defaultMcpName(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === 'localhost') return 'localhost';
  return parsed.hostname.startsWith('www.') ? parsed.hostname.slice(4) : parsed.hostname;
}
function statusLabel(response: Response): string {
  const text = response.statusText || STATUS_TEXT[response.status] || '';
  return `${response.status}${text ? ` ${text}` : ''}`;
}
function bareOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}
function sameEndpointWithTrailingSlash(source: URL, target: URL): boolean {
  const configPath = source.pathname.replace(/\/+$/g, '');
  const installedPath = target.pathname.replace(/\/+$/g, '');
  return (
    source.host === target.host &&
    configPath.length > 0 &&
    configPath === installedPath &&
    target.pathname.endsWith('/') &&
    source.search === target.search
  );
}
function redirectWorkingUrl(url: string, response: Response): string | undefined {
  const location = response.headers.get('location');
  if (!location) return undefined;
  try {
    const source = new URL(url);
    const target = new URL(location, source);
    if (!sameEndpointWithTrailingSlash(source, target)) return undefined;
    return `${source.protocol}//${source.host}${target.pathname}${target.search}`;
  } catch {
    return undefined;
  }
}
function errorLabel(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `timeout after ${timeoutMs}ms`;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return `timeout after ${timeoutMs}ms`;
    return error.message || error.name;
  }
  return String(error);
}
export async function probeMcpEndpoint(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {}
): Promise<ProbeAttempt> {
  if (!validateHttpUrl(url)) {
    return { url, success: false, result: 'malformed URL' };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const success =
      (response.status >= 200 && response.status < 400) || OK_STATUS_CODES.has(response.status);
    const workingUrl = redirectWorkingUrl(url, response);
    return { url, success, result: statusLabel(response), ...(workingUrl ? { workingUrl } : {}) };
  } catch (error) {
    return { url, success: false, result: errorLabel(error, timeoutMs) };
  } finally {
    clearTimeout(timeout);
  }
}
export async function probeMcpCandidates(
  candidates: string[],
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {}
): Promise<ProbeResult> {
  const attempts: ProbeAttempt[] = [];
  let bareOriginFallback: ProbeAttempt | null = null;
  for (const url of candidates) {
    const attempt = await probeMcpEndpoint(url, options);
    attempts.push(attempt);
    if (!attempt.success) continue;
    if (bareOrigin(attempt.url)) {
      bareOriginFallback ??= attempt;
      continue;
    }
    return { workingUrl: attempt.workingUrl ?? attempt.url, attempts };
  }
  if (bareOriginFallback) {
    return { workingUrl: bareOriginFallback.workingUrl ?? bareOriginFallback.url, attempts };
  }
  return { attempts };
}
export function formatProbeFailure(attempts: ProbeAttempt[]): string {
  return [
    'Could not find a reachable MCP endpoint.',
    '',
    'Tried:',
    ...attempts.map((attempt) => `  ${attempt.url} -> ${attempt.result}`),
  ].join('\n');
}
function resolveAgents(scope: Scope, selection: AgentSelection): AgentType[] {
  const capable = getMcpCapableAgents({ global: scope === 'global' });
  if (selection.all) return capable;
  const unsupported = selection.agents.filter((agent) => !capable.includes(agent));
  if (unsupported.length > 0) {
    const scopeLabel = scope === 'project' ? 'local' : 'global';
    throw new Error(
      `Agent(s) do not support MCP configuration at ${scopeLabel} scope: ${unsupported.join(', ')}`
    );
  }
  return selection.agents;
}
function formatAgentList(agentTypes: AgentType[]): string {
  return agentTypes
    .map((agent) => mcpAgents[agent]?.displayName ?? agents[agent].displayName)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}
function formatScope(scope: Scope): string {
  return scope === 'project' ? 'local' : 'global';
}
export async function installRemoteMcpServer(params: {
  name: string;
  url: string;
  scope: Scope;
  agents: AgentType[];
}): Promise<McpAddInstallResult> {
  const server: McpServer = {
    name: params.name,
    transport: 'http',
    url: params.url,
  };
  const global = params.scope === 'global';
  const results: McpInstallResult[] = [];
  for (const agent of params.agents) {
    results.push({
      agent,
      ...(await installMcpServerForAgent(server, agent, { global })),
    });
  }
  if (results.some((result) => result.success)) {
    await addMcpToLock(server, { source: params.url, sourceType: 'direct' }, { global });
  }
  return { server, scope: params.scope, agents: params.agents, results };
}
function reportInstallResult(result: McpAddInstallResult): void {
  const successfulAgents = new Set(
    result.results.filter((entry) => entry.success).map((entry) => entry.agent)
  );
  const failed = result.results.filter((entry) => !entry.success);
  if (successfulAgents.size > 0) {
    p.log.success(`Installed MCP server ${result.server.name}`);
    p.log.message(`  URL: ${result.server.url ?? ''}`);
    p.log.message(`  Scope: ${formatScope(result.scope)}`);
    p.log.message(`  Agents: ${formatAgentList([...successfulAgents])}`);
  }
  if (failed.length > 0) {
    p.log.error(`Failed ${failed.length} install step(s)`);
    for (const entry of failed) {
      const agent = entry.agent as AgentType;
      const label = mcpAgents[agent]?.displayName ?? agents[agent].displayName;
      p.log.message(`  ${pc.red('✗')} ${label}: ${entry.error ?? 'failed'}`);
    }
  }
}
export async function runMcpAdd(args: string[]): Promise<void> {
  const parsed = parseMcpAddArgs(args);
  const targetAgents = resolveAgents(parsed.scope, parsed.agents);
  if (targetAgents.length === 0) {
    throw new Error(`No agents support MCP configuration at ${formatScope(parsed.scope)} scope.`);
  }
  p.intro(pc.bgCyan(pc.black(' sloprider mcp add ')));
  const probeResult = await probeMcpCandidates(buildMcpUrlCandidates(parsed.inputUrl));
  if (!probeResult.workingUrl) throw new Error(formatProbeFailure(probeResult.attempts));
  const name = parsed.name ?? defaultMcpName(probeResult.workingUrl);
  const installResult = await installRemoteMcpServer({
    name,
    url: probeResult.workingUrl,
    scope: parsed.scope,
    agents: targetAgents,
  });
  reportInstallResult(installResult);
  p.outro(pc.green('Done!'));
}
export async function runInteractiveMcpAdd(): Promise<void> {
  const value = await p.text({ message: 'Remote MCP URL' });
  if (isCancel(value)) {
    p.log.warn('Cancelled.');
    return;
  }
  if (!value || typeof value !== 'string') return;
  const probeResult = await probeMcpCandidates(buildMcpUrlCandidates(value));
  if (!probeResult.workingUrl) {
    p.log.error(formatProbeFailure(probeResult.attempts));
    return;
  }
  const defaultName = defaultMcpName(probeResult.workingUrl);
  const nameValue = await p.text({
    message: 'MCP server name',
    initialValue: defaultName,
    defaultValue: defaultName,
  });
  if (isCancel(nameValue)) {
    p.log.warn('Cancelled.');
    return;
  }
  const name = String(nameValue || defaultName).trim() || defaultName;
  const scopeValue = await p.select({
    message: 'Installation scope',
    options: [
      { value: 'project' as const, label: 'Local', hint: 'Current repository' },
      { value: 'global' as const, label: 'Global', hint: 'User-level agent config' },
    ],
  });
  if (isCancel(scopeValue)) {
    p.log.warn('Cancelled.');
    return;
  }
  const targetAgents = await p.multiselect({
    message: `Select agents ${pc.dim('(space to toggle)')}`,
    options: getMcpCapableAgents({ global: scopeValue === 'global' }).map((agent) => ({
      value: agent,
      label: mcpAgents[agent]?.displayName ?? agents[agent].displayName,
    })),
    required: true,
  });
  if (isCancel(targetAgents)) {
    p.log.warn('Cancelled.');
    return;
  }
  const selectedAgents = targetAgents as AgentType[];
  p.log.message(`Name: ${name}`);
  p.log.message(`URL: ${probeResult.workingUrl}`);
  p.log.message(`Scope: ${formatScope(scopeValue)}`);
  p.log.message(`Agents: ${formatAgentList(selectedAgents)}`);
  const confirmed = await p.confirm({ message: 'Install this MCP server?' });
  if (isCancel(confirmed) || !confirmed) {
    p.log.warn('Cancelled.');
    return;
  }
  const installResult = await installRemoteMcpServer({
    name,
    url: probeResult.workingUrl,
    scope: scopeValue,
    agents: selectedAgents,
  });
  reportInstallResult(installResult);
}
