import * as p from '@clack/prompts';
import pc from '../ui/colors.ts';
import { agents } from '../core/agents.ts';
import { cleanupTempDir, GitCloneError } from '../repo/clone.ts';
import {
  assertNoDuplicateNames,
  discoverRepo,
  installArtifacts,
  selectableAgents,
  type Artifact,
} from './discover.ts';
import { parseScope, type InstallScope } from '../core/scope.ts';
import { getSkillDisplayName } from '../artifacts/skills.ts';
import type { AgentType } from '../core/agents.ts';
type AgentSelection = { all: true; agents: AgentType[] } | { all: false; agents: AgentType[] };
type ParsedInstallArgs = {
  source: string;
  scope: InstallScope;
  agents: AgentSelection;
  skillNames: string[];
  mcpNames: string[];
  hookNames: string[];
  pluginNames: string[];
};
const INSTALL_USAGE =
  'Usage: sloprider install <git-url> --scope project|global --agents all|agent[,agent...] (--skills names | --mcps names | --hooks names | --plugins names)';
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function parseAgentSelection(value: string | undefined): AgentSelection {
  if (!value) throw new Error('--agents is required');
  if (value === 'all') return { all: true, agents: [] };
  const knownAgents = new Set(Object.keys(agents));
  const selected = splitList(value);
  if (selected.length === 0) throw new Error('--agents must name at least one agent or all');
  const invalid = selected.filter((agent) => !knownAgents.has(agent));
  if (invalid.length > 0) {
    throw new Error(`Unknown agent(s): ${invalid.join(', ')}`);
  }
  return { all: false, agents: selected as AgentType[] };
}
function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const source = args[0];
  if (!source || source.startsWith('-')) throw new Error(INSTALL_USAGE);
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const name = rawName ?? '';
    const value = inlineValue ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    if (!['scope', 'agents', 'skills', 'mcps', 'hooks', 'plugins'].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
    flags.set(name, value);
  }
  const skillNames = splitList(flags.get('skills') ?? '');
  const mcpNames = splitList(flags.get('mcps') ?? '');
  const hookNames = splitList(flags.get('hooks') ?? '');
  const pluginNames = splitList(flags.get('plugins') ?? '');
  if (
    skillNames.length === 0 &&
    mcpNames.length === 0 &&
    hookNames.length === 0 &&
    pluginNames.length === 0
  ) {
    throw new Error('At least one of --skills, --mcps, --hooks, or --plugins is required.');
  }
  return {
    source,
    scope: parseScope(flags.get('scope')),
    agents: parseAgentSelection(flags.get('agents')),
    skillNames,
    mcpNames,
    hookNames,
    pluginNames,
  };
}
function resolveByName<T>(
  items: T[],
  requested: string[],
  kind: string,
  getName: (item: T) => string
): T[] {
  const byName = new Map<string, T[]>();
  for (const item of items) {
    const key = getName(item).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), item]);
  }
  const selected: T[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate ${kind} requested: ${name}`);
    seen.add(key);
    const matches = byName.get(key) ?? [];
    if (matches.length === 0) {
      const available = [...byName.values()].flat().map(getName).join(', ') || 'none';
      throw new Error(`Unknown ${kind}: ${name}. Available ${kind}s: ${available}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous ${kind}: ${name}`);
    }
    selected.push(matches[0]!);
  }
  return selected;
}
function selectedArtifacts(
  discovered: Awaited<ReturnType<typeof discoverRepo>>,
  args: ParsedInstallArgs
): Artifact[] {
  return [
    ...resolveByName(discovered.skills, args.skillNames, 'skill', getSkillDisplayName).map(
      (skill) => ({ type: 'skill' as const, skill })
    ),
    ...resolveByName(discovered.mcps, args.mcpNames, 'MCP server', (server) => server.name).map(
      (server) => ({ type: 'mcp' as const, server })
    ),
    ...resolveByName(discovered.hooks, args.hookNames, 'hook', (hook) => hook.name).map((hook) => ({
      type: 'hook' as const,
      hook,
    })),
    ...resolveByName(discovered.plugins, args.pluginNames, 'plugin', (plugin) => plugin.name).map(
      (plugin) => ({ type: 'plugin' as const, plugin })
    ),
  ];
}
function resolveTargetAgents(
  scope: InstallScope,
  artifacts: Artifact[],
  selection: AgentSelection
): AgentType[] {
  const hooks = artifacts.filter(
    (artifact): artifact is Extract<Artifact, { type: 'hook' }> => artifact.type === 'hook'
  );
  if (scope === 'global' && hooks.length > 0) {
    throw new Error('Hooks are project-only; use --scope project for hooks.');
  }
  if (!selection.all) {
    const missingHookAgents = hooks
      .map((artifact) => artifact.hook.agent)
      .filter((agent) => !selection.agents.includes(agent));
    if (missingHookAgents.length > 0) {
      throw new Error(
        `Selected hook(s) target ${[...new Set(missingHookAgents)].join(
          ', '
        )}; include those agents in --agents or use --agents all.`
      );
    }
  }
  const nonHookArtifacts = artifacts.filter((artifact) => artifact.type !== 'hook');
  if (nonHookArtifacts.length === 0) return [];
  const compatible = selectableAgents(scope, nonHookArtifacts);
  if (selection.all) {
    if (compatible.length === 0) {
      throw new Error(`No agents support the selected artifacts at ${scope} scope.`);
    }
    return compatible;
  }
  const incompatible = selection.agents.filter((agent) => !compatible.includes(agent));
  if (incompatible.length > 0) {
    throw new Error(
      `Agent(s) do not support the selected artifacts at ${scope} scope: ${incompatible.join(', ')}`
    );
  }
  return selection.agents;
}
export async function runInstall(args: string[]): Promise<void> {
  const parsedArgs = parseInstallArgs(args);
  let repoDir: string | null = null;
  try {
    p.intro(pc.bgCyan(pc.black(' sloprider install ')));
    const discovered = await discoverRepo(parsedArgs.source);
    repoDir = discovered.repoDir;
    const artifacts = selectedArtifacts(discovered, parsedArgs);
    assertNoDuplicateNames(discovered.repoDir, artifacts);
    const targetAgents = resolveTargetAgents(parsedArgs.scope, artifacts, parsedArgs.agents);
    await installArtifacts(
      parsedArgs.source,
      discovered.parsed,
      discovered.repoDir,
      artifacts,
      parsedArgs.scope,
      targetAgents
    );
    p.outro(pc.green('Done!'));
  } catch (error) {
    if (error instanceof GitCloneError) {
      throw new Error(error.message);
    }
    throw error;
  } finally {
    if (repoDir) await cleanupTempDir(repoDir).catch(() => {});
  }
}
