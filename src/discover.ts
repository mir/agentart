import * as p from '@clack/prompts';
import { join, relative, sep } from 'path';
import pc from './colors.ts';
import { agents } from './agents.ts';
import { cleanupTempDir, cloneRepo, GitCloneError } from './git.ts';
import {
  discoverHooks,
  formatHookAgent,
  installHookBundle,
  type DiscoveredHookBundle,
} from './hooks.ts';
import { installSkillForAgent } from './installer.ts';
import { discoverMcpServers, type DiscoveredMcpServer } from './mcp-discovery.ts';
import { getMcpCapableAgents, mcpAgents } from './mcp-agents.ts';
import { installMcpServerForAgent } from './mcp-config.ts';
import { addMcpToLock, type McpLockEntry } from './mcp-lock.ts';
import { discoverPlugins } from './plugin-discovery.ts';
import {
  addMarketplaceForAgent,
  getPluginCapableAgents,
  installPluginForAgent,
} from './plugin-agents.ts';
import { addPluginToLock } from './plugin-lock.ts';
import { hashPluginManifest } from './plugin-discovery.ts';
import { parseSource, getOwnerRepo } from './source-parser.ts';
import { addSkillToLock } from './skill-lock.ts';
import { addSkillToLocalLock, computeSkillFolderHash } from './local-lock.ts';
import { getCommitSha } from './git-sha.ts';
import { discoverSkills, getDuplicateSkillNameGroups, getSkillDisplayName } from './skills.ts';
import type { AgentType, DiscoveredPlugin, ParsedSource, Skill } from './types.ts';
import type { McpServer } from './mcp-types.ts';

export type Scope = 'project' | 'global';
export type Artifact =
  | { type: 'skill'; skill: Skill }
  | { type: 'mcp'; server: DiscoveredMcpServer }
  | { type: 'hook'; hook: DiscoveredHookBundle }
  | { type: 'plugin'; plugin: DiscoveredPlugin };

function isCancel(value: unknown): value is symbol {
  return typeof value === 'symbol';
}

function parseGitSource(input: string): ParsedSource {
  const parsed = parseSource(input);
  if (parsed.type === 'local') {
    throw new Error('discover expects a git URL, not a local path');
  }
  return parsed;
}

export function displayMcp(server: DiscoveredMcpServer): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return server.url ?? '';
}

function stripMcpMetadata(server: DiscoveredMcpServer): McpServer {
  const { sourcePath: _, ...next } = server;
  return next;
}

function repoPluginSource(parsed: ParsedSource, plugin: DiscoveredPlugin) {
  return {
    ...plugin,
    source: {
      source: 'git-subdir' as const,
      url: parsed.url,
      path: plugin.sourcePath === '.' ? '.' : `./${plugin.sourcePath}`,
      ref: parsed.ref,
    },
  };
}

export function relSkillPath(repoDir: string, skill: Skill): string {
  return relative(repoDir, join(skill.path, 'SKILL.md')).split(sep).join('/');
}

function normalizeDisplayPath(path: string): string {
  return path.split(sep).join('/');
}

export function skillSourceLabel(repoDir: string, skill: Skill): string {
  return normalizeDisplayPath(relative(repoDir, skill.path)) || '.';
}

export function mcpSourceLabel(server: DiscoveredMcpServer): string {
  return server.sourcePath;
}

function hookSourceLabel(hook: DiscoveredHookBundle): string {
  return hook.sourcePath;
}

function pluginSourceLabel(plugin: DiscoveredPlugin): string {
  return plugin.sourcePath;
}

export function artifactSourceLabel(repoDir: string, artifact: Artifact): string {
  if (artifact.type === 'skill') return skillSourceLabel(repoDir, artifact.skill);
  if (artifact.type === 'mcp') return mcpSourceLabel(artifact.server);
  if (artifact.type === 'hook') return hookSourceLabel(artifact.hook);
  return pluginSourceLabel(artifact.plugin);
}

export function selectableAgents(scope: Scope, artifacts: Artifact[]): AgentType[] {
  const hasSkill = artifacts.some((artifact) => artifact.type === 'skill');
  const hasMcp = artifacts.some((artifact) => artifact.type === 'mcp');
  const hasPlugin = artifacts.some((artifact) => artifact.type === 'plugin');
  const agentSelectableArtifacts = artifacts.filter((artifact) => artifact.type !== 'hook');
  if (agentSelectableArtifacts.length === 0) return [];
  let names = Object.keys(agents) as AgentType[];

  if (scope === 'global') {
    names = names.filter((agent) => agents[agent].globalSkillsDir);
  }
  if (hasMcp) {
    const mcpCapable = getMcpCapableAgents({ global: scope === 'global' });
    names = names.filter((agent) => mcpCapable.includes(agent));
  }
  if (hasPlugin) {
    const pluginCapable = getPluginCapableAgents();
    names = names.filter((agent) => pluginCapable.includes(agent as any));
  }
  if (!hasSkill && (hasMcp || hasPlugin)) {
    return names;
  }
  return names;
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function countByName<T>(items: T[], getName: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getName(item).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function artifactSelectOptions(
  repoDir: string,
  skills: Skill[],
  mcps: DiscoveredMcpServer[],
  hooks: DiscoveredHookBundle[],
  plugins: DiscoveredPlugin[] = []
): Record<string, p.Option<Artifact>[]> {
  const groups: Record<string, p.Option<Artifact>[]> = {};
  const skillNameCounts = countByName(skills, getSkillDisplayName);

  const skillOptions = [...skills]
    .sort((a, b) => {
      const sourceDiff = compareStrings(skillSourceLabel(repoDir, a), skillSourceLabel(repoDir, b));
      if (sourceDiff !== 0) return sourceDiff;
      return compareStrings(getSkillDisplayName(a), getSkillDisplayName(b));
    })
    .map((skill) => {
      const source = skillSourceLabel(repoDir, skill);
      const name = getSkillDisplayName(skill);
      const duplicateName = (skillNameCounts.get(name.toLowerCase()) ?? 0) > 1;
      return {
        value: { type: 'skill' as const, skill },
        label: duplicateName ? `skill: ${name} [${source}]` : `skill: ${name}`,
        hint: duplicateName
          ? skill.description
          : [source, skill.description].filter(Boolean).join(' - '),
      };
    });
  if (skillOptions.length > 0) groups.Skills = skillOptions;

  const mcpsBySource = new Map<string, DiscoveredMcpServer[]>();
  for (const server of mcps) {
    const source = mcpSourceLabel(server);
    mcpsBySource.set(source, [...(mcpsBySource.get(source) ?? []), server]);
  }
  for (const source of [...mcpsBySource.keys()].sort(compareStrings)) {
    groups[`MCP servers from ${source}`] = [...(mcpsBySource.get(source) ?? [])]
      .sort((a, b) => {
        const nameDiff = compareStrings(a.name, b.name);
        if (nameDiff !== 0) return nameDiff;
        return compareStrings(displayMcp(a), displayMcp(b));
      })
      .map((server) => ({
        value: { type: 'mcp' as const, server },
        label: `mcp: ${server.name} [${source}]`,
        hint: displayMcp(server),
      }));
  }

  const hooksBySource = new Map<string, DiscoveredHookBundle[]>();
  for (const hook of hooks) {
    const source = hookSourceLabel(hook);
    hooksBySource.set(source, [...(hooksBySource.get(source) ?? []), hook]);
  }
  for (const source of [...hooksBySource.keys()].sort(compareStrings)) {
    groups[`Hooks from ${source}`] = [...(hooksBySource.get(source) ?? [])]
      .sort((a, b) => {
        const agentDiff = compareStrings(formatHookAgent(a.agent), formatHookAgent(b.agent));
        if (agentDiff !== 0) return agentDiff;
        return compareStrings(a.name, b.name);
      })
      .map((hook) => ({
        value: { type: 'hook' as const, hook },
        label: `hook: ${hook.name} -> ${formatHookAgent(hook.agent)}`,
        hint: hook.events.join(', '),
      }));
  }

  const pluginsBySource = new Map<string, DiscoveredPlugin[]>();
  for (const plugin of plugins) {
    const source = pluginSourceLabel(plugin);
    pluginsBySource.set(source, [...(pluginsBySource.get(source) ?? []), plugin]);
  }
  for (const source of [...pluginsBySource.keys()].sort(compareStrings)) {
    groups[`Plugins from ${source}`] = [...(pluginsBySource.get(source) ?? [])]
      .sort((a, b) => compareStrings(a.name, b.name))
      .map((plugin) => ({
        value: { type: 'plugin' as const, plugin },
        label: `plugin: ${plugin.name} [${source}]`,
        hint: plugin.description ?? plugin.category ?? '',
      }));
  }

  return groups;
}

function viewportMaxItems(): number {
  const rows = process.stdout.rows ?? 24;
  return Math.max(8, Math.min(20, rows - 8));
}

export function flattenArtifactOptions(
  groups: Record<string, p.Option<Artifact>[]>
): p.Option<Artifact>[] {
  const out: p.Option<Artifact>[] = [];
  for (const [groupLabel, items] of Object.entries(groups)) {
    for (const item of items) {
      out.push({
        ...item,
        hint: item.hint ? `${groupLabel} — ${item.hint}` : groupLabel,
      });
    }
  }
  return out;
}

async function selectArtifacts(
  repoDir: string,
  skills: Skill[],
  mcps: DiscoveredMcpServer[],
  hooks: DiscoveredHookBundle[],
  plugins: DiscoveredPlugin[]
): Promise<Artifact[]> {
  const groups = artifactSelectOptions(repoDir, skills, mcps, hooks, plugins);
  const options = flattenArtifactOptions(groups);
  const selected = await p.multiselect<Artifact>({
    message: `Select artifacts to install ${pc.dim('(space to toggle, ↑/↓ to scroll)')}`,
    options,
    required: true,
    maxItems: viewportMaxItems(),
  });

  if (isCancel(selected)) {
    p.cancel('Installation cancelled');
    process.exit(0);
  }

  return selected as Artifact[];
}

async function selectScope(): Promise<Scope> {
  const selected = await p.select({
    message: 'Installation scope',
    options: [
      { value: 'project' as const, label: 'Project', hint: 'Current repository' },
      { value: 'global' as const, label: 'Global', hint: 'User-level agent config' },
    ],
  });

  if (isCancel(selected)) {
    p.cancel('Installation cancelled');
    process.exit(0);
  }

  return selected;
}

async function selectAgents(scope: Scope, artifacts: Artifact[]): Promise<AgentType[]> {
  if (artifacts.every((artifact) => artifact.type === 'hook')) return [];

  const choices = selectableAgents(scope, artifacts).map((agent) => ({
    value: agent,
    label: mcpAgents[agent]?.displayName ?? agents[agent].displayName,
  }));

  if (choices.length === 0) {
    throw new Error(`No agents support the selected artifacts at ${scope} scope.`);
  }

  const selected = await p.multiselect({
    message: `Select agents ${pc.dim('(space to toggle)')}`,
    options: choices,
    required: true,
  });

  if (isCancel(selected)) {
    p.cancel('Installation cancelled');
    process.exit(0);
  }

  return selected as AgentType[];
}

async function confirmHooks(hooks: DiscoveredHookBundle[]): Promise<void> {
  if (hooks.length === 0) return;
  p.log.warn('Hooks execute commands. Review the selected hook bundles before installing.');
  for (const hook of hooks) {
    p.log.message(`  ${hook.name} -> ${formatHookAgent(hook.agent)} (${hook.events.join(', ')})`);
  }
  const confirmed = await p.confirm({ message: 'Install selected hook bundles?' });
  if (isCancel(confirmed) || !confirmed) {
    p.cancel('Installation cancelled');
    process.exit(0);
  }
}

function duplicateSourceError(kind: string, name: string, sources: string[]): Error {
  return new Error(
    [
      `Duplicate ${kind} selected: ${name}`,
      'Choose one source:',
      ...sources.map((source) => `  ${source}`),
    ].join('\n')
  );
}

export function assertNoDuplicateNames(repoDir: string, artifacts: Artifact[]): void {
  const skills = artifacts
    .filter(
      (artifact): artifact is Extract<Artifact, { type: 'skill' }> => artifact.type === 'skill'
    )
    .map((artifact) => artifact.skill);
  const duplicateSkills = getDuplicateSkillNameGroups(skills);
  if (duplicateSkills.size > 0) {
    const [name, group] = [...duplicateSkills.entries()][0]!;
    throw duplicateSourceError(
      'skill',
      name,
      group.map((skill) => skillSourceLabel(repoDir, skill))
    );
  }

  const mcpsByName = new Map<string, DiscoveredMcpServer[]>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'mcp') continue;
    const key = artifact.server.name.toLowerCase();
    mcpsByName.set(key, [...(mcpsByName.get(key) ?? []), artifact.server]);
  }
  for (const group of mcpsByName.values()) {
    if (group.length < 2) continue;
    throw duplicateSourceError('MCP', group[0]!.name, group.map(mcpSourceLabel));
  }

  const hooksByAgentName = new Map<string, DiscoveredHookBundle[]>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'hook') continue;
    const key = `${artifact.hook.agent}:${artifact.hook.name.toLowerCase()}`;
    hooksByAgentName.set(key, [...(hooksByAgentName.get(key) ?? []), artifact.hook]);
  }
  for (const group of hooksByAgentName.values()) {
    if (group.length < 2) continue;
    throw duplicateSourceError(
      'hook',
      group[0]!.name,
      group.map((hook) => `${hookSourceLabel(hook)} (${formatHookAgent(hook.agent)})`)
    );
  }

  const pluginsByName = new Map<string, DiscoveredPlugin[]>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'plugin') continue;
    const key = artifact.plugin.name.toLowerCase();
    pluginsByName.set(key, [...(pluginsByName.get(key) ?? []), artifact.plugin]);
  }
  for (const group of pluginsByName.values()) {
    if (group.length < 2) continue;
    throw duplicateSourceError('plugin', group[0]!.name, group.map(pluginSourceLabel));
  }
}

export async function discoverRepo(source: string): Promise<{
  parsed: ParsedSource;
  repoDir: string;
  skills: Skill[];
  mcps: DiscoveredMcpServer[];
  hooks: DiscoveredHookBundle[];
  plugins: DiscoveredPlugin[];
}> {
  const parsed = parseGitSource(source);
  const spinner = p.spinner();
  spinner.start('Cloning repository...');
  let repoDir: string;
  try {
    repoDir = await cloneRepo(parsed.url, parsed.ref, {
      onProgress: (message) => spinner.message(`Cloning repository... ${message}`),
    });
    spinner.stop('Repository cloned');
  } catch (error) {
    spinner.stop('Failed to clone repository', 1);
    throw error;
  }

  spinner.start('Scanning for skills, MCPs, hooks, and plugins...');
  const base = parsed.subpath ? join(repoDir, parsed.subpath) : repoDir;
  let skills: Skill[];
  let mcps: DiscoveredMcpServer[];
  let hooks: DiscoveredHookBundle[];
  let plugins: DiscoveredPlugin[];
  try {
    [skills, mcps, hooks, plugins] = await Promise.all([
      discoverSkills(repoDir, parsed.subpath),
      discoverMcpServers(base),
      discoverHooks(base),
      discoverPlugins(base),
    ]);
    spinner.stop(
      `Found ${skills.length} skill(s), ${mcps.length} MCP server(s), ${hooks.length} hook bundle(s), and ${plugins.length} plugin(s)`
    );
  } catch (error) {
    spinner.stop('Failed to scan repository', 1);
    throw error;
  }
  return { parsed, repoDir, skills, mcps, hooks, plugins };
}

async function writeSkillLocks(
  scope: Scope,
  source: string,
  parsed: ParsedSource,
  repoDir: string,
  installedSkills: Skill[],
  sourceSha?: string
): Promise<void> {
  const normalizedSource = getOwnerRepo(parsed);
  const lockSource = parsed.url.startsWith('git@') ? parsed.url : normalizedSource || parsed.url;

  await Promise.all(
    installedSkills.map(async (skill) => {
      const skillPath = relSkillPath(repoDir, skill);
      const hash = await computeSkillFolderHash(skill.path);
      if (scope === 'global') {
        await addSkillToLock(skill.name, {
          source: lockSource,
          sourceType: parsed.type,
          sourceUrl: parsed.url,
          ref: parsed.ref,
          skillPath,
          skillFolderHash: hash,
          sourceSha,
          pluginName: skill.pluginName,
        });
      } else {
        await addSkillToLocalLock(skill.name, {
          source: lockSource || source,
          sourceType: parsed.type,
          ref: parsed.ref,
          skillPath,
          computedHash: hash,
          sourceSha,
        });
      }
    })
  );
}

export async function installArtifacts(
  source: string,
  parsed: ParsedSource,
  repoDir: string,
  artifacts: Artifact[],
  scope: Scope,
  targetAgents: AgentType[]
): Promise<void> {
  const global = scope === 'global';
  const sourceSha = (await getCommitSha(repoDir)) ?? undefined;
  const skills = artifacts
    .filter(
      (artifact): artifact is Extract<Artifact, { type: 'skill' }> => artifact.type === 'skill'
    )
    .map((artifact) => artifact.skill);
  const mcps = artifacts
    .filter((artifact): artifact is Extract<Artifact, { type: 'mcp' }> => artifact.type === 'mcp')
    .map((artifact) => artifact.server);
  const hooks = artifacts
    .filter((artifact): artifact is Extract<Artifact, { type: 'hook' }> => artifact.type === 'hook')
    .map((artifact) => artifact.hook);
  const plugins = artifacts
    .filter(
      (artifact): artifact is Extract<Artifact, { type: 'plugin' }> => artifact.type === 'plugin'
    )
    .map((artifact) => artifact.plugin);

  const skillResults: Array<{
    skill: Skill;
    agent: AgentType;
    result: Awaited<ReturnType<typeof installSkillForAgent>>;
  }> = [];
  for (const skill of skills) {
    for (const agent of targetAgents) {
      skillResults.push({
        skill,
        agent,
        result: await installSkillForAgent(skill, agent, { global }),
      });
    }
  }

  const mcpResults = [];
  const mcpAgentsForScope = getMcpCapableAgents({ global });
  for (const discovered of mcps) {
    const server = stripMcpMetadata(discovered);
    const agentsForServer = targetAgents.filter((agent) => mcpAgentsForScope.includes(agent));
    for (const agent of agentsForServer) {
      mcpResults.push({
        server,
        agent,
        result: await installMcpServerForAgent(server, agent, { global }),
      });
    }
    if (agentsForServer.length > 0) {
      await addMcpToLock(
        server,
        {
          source: parsed.url.startsWith('git@') ? parsed.url : getOwnerRepo(parsed) || parsed.url,
          sourceType: parsed.type as McpLockEntry['sourceType'],
          sourceUrl: parsed.url,
          ref: parsed.ref,
          sourceSha,
        },
        { global }
      );
    }
  }

  const installedSkills = skills.filter((skill) =>
    skillResults.some((entry) => entry.skill === skill && entry.result.success)
  );
  await writeSkillLocks(scope, source, parsed, repoDir, installedSkills, sourceSha);

  const failed = [
    ...skillResults
      .filter((entry) => !entry.result.success)
      .map(
        (entry) =>
          `${entry.skill.name} -> ${agents[entry.agent].displayName}: ${entry.result.error ?? 'failed'}`
      ),
    ...mcpResults
      .filter((entry) => !entry.result.success)
      .map(
        (entry) =>
          `${entry.server.name} -> ${mcpAgents[entry.agent]?.displayName ?? agents[entry.agent].displayName}: ${entry.result.error ?? 'failed'}`
      ),
  ];

  const installedSkillNames = new Set(installedSkills.map((skill) => skill.name));
  const installedMcpNames = new Set(
    mcpResults.filter((entry) => entry.result.success).map((entry) => entry.server.name)
  );
  const base = parsed.subpath ? join(repoDir, parsed.subpath) : repoDir;
  const hookResults = [];
  for (const hook of hooks) {
    hookResults.push(
      await installHookBundle(
        base,
        hook,
        parsed,
        parsed.url.startsWith('git@') ? parsed.url : getOwnerRepo(parsed) || parsed.url,
        process.cwd(),
        sourceSha
      )
    );
  }

  const pluginResults = [];
  const pluginAgents = getPluginCapableAgents();
  const pluginTargetAgents = targetAgents.filter((agent) => pluginAgents.includes(agent as any));
  const marketplaceSource = parsed.url.startsWith('git@')
    ? parsed.url
    : getOwnerRepo(parsed) || parsed.url;
  const claudeMarketplaceAdded = new Set<string>();
  for (const plugin of plugins) {
    const installPlugin = repoPluginSource(parsed, plugin);
    for (const agent of pluginTargetAgents) {
      if (
        agent === 'claude-code' &&
        plugin.marketplaceName &&
        !claudeMarketplaceAdded.has(marketplaceSource)
      ) {
        try {
          await addMarketplaceForAgent(marketplaceSource, 'claude-code', scope);
        } catch {}
        claudeMarketplaceAdded.add(marketplaceSource);
      }
      pluginResults.push({
        plugin,
        agent,
        result: await installPluginForAgent(
          installPlugin,
          agent as any,
          scope,
          'INSTALLED_BY_DEFAULT'
        ),
      });
    }
    const successfulAgents = pluginResults
      .filter((entry) => entry.plugin === plugin && entry.result.success)
      .map((entry) => entry.agent);
    if (successfulAgents.length > 0) {
      const manifestHash = await hashPluginManifest(
        plugin.manifestPath ? join(base, plugin.manifestPath) : undefined
      );
      await addPluginToLock(
        plugin.name,
        {
          name: plugin.name,
          agents: successfulAgents,
          scope,
          source: parsed.url.startsWith('git@') ? parsed.url : getOwnerRepo(parsed) || parsed.url,
          sourceType: parsed.type,
          sourceUrl: parsed.url,
          ref: parsed.ref,
          pluginPath: plugin.sourcePath,
          marketplaceName: plugin.marketplaceName,
          marketplacePath: plugin.marketplacePath,
          targetPath: plugin.sourcePath,
          manifestHash,
          pluginSource: installPlugin.source,
          sourceSha,
        },
        { global }
      );
    }
  }

  if (installedSkillNames.size > 0) {
    p.log.success(`Installed ${installedSkillNames.size} skill(s)`);
    for (const name of installedSkillNames) p.log.message(`  ${pc.green('✓')} ${name}`);
  }
  if (installedMcpNames.size > 0) {
    p.log.success(`Installed ${installedMcpNames.size} MCP server(s)`);
    for (const name of installedMcpNames) p.log.message(`  ${pc.green('✓')} ${name}`);
  }
  const installedHookNames = new Set(
    hookResults.filter((entry) => entry.success).map((entry) => entry.name)
  );
  if (installedHookNames.size > 0) {
    p.log.success(`Installed ${installedHookNames.size} hook bundle(s)`);
    for (const name of installedHookNames) p.log.message(`  ${pc.green('✓')} ${name}`);
  }
  failed.push(
    ...hookResults
      .filter((entry) => !entry.success)
      .map(
        (entry) => `${entry.name} -> ${formatHookAgent(entry.agent)}: ${entry.error ?? 'failed'}`
      )
  );
  const installedPluginNames = new Set(
    pluginResults.filter((entry) => entry.result.success).map((entry) => entry.plugin.name)
  );
  if (installedPluginNames.size > 0) {
    p.log.success(`Installed ${installedPluginNames.size} plugin(s)`);
    for (const name of installedPluginNames) p.log.message(`  ${pc.green('✓')} ${name}`);
  }
  failed.push(
    ...pluginResults
      .filter((entry) => !entry.result.success)
      .map(
        (entry) =>
          `${entry.plugin.name} -> ${agents[entry.agent].displayName}: ${entry.result.error ?? 'failed'}`
      )
  );
  if (failed.length > 0) {
    p.log.error(`Failed ${failed.length} install step(s)`);
    for (const line of failed) p.log.message(`  ${pc.red('✗')} ${line}`);
  }
}

export async function runInteractiveDiscover(args: string[]): Promise<void> {
  const source = args[0];
  if (!source || args.length !== 1) {
    throw new Error('Usage: sloprider discover <git-url>');
  }

  let repoDir: string | null = null;
  try {
    p.intro(pc.bgCyan(pc.black(' sloprider discover ')));
    const discovered = await discoverRepo(source);
    repoDir = discovered.repoDir;

    if (
      discovered.skills.length === 0 &&
      discovered.mcps.length === 0 &&
      discovered.hooks.length === 0 &&
      discovered.plugins.length === 0
    ) {
      throw new Error('No skills, MCP servers, hook bundles, or plugins found in this repository.');
    }

    const artifacts = await selectArtifacts(
      discovered.repoDir,
      discovered.skills,
      discovered.mcps,
      discovered.hooks,
      discovered.plugins
    );
    assertNoDuplicateNames(discovered.repoDir, artifacts);
    const scope = await selectScope();
    if (scope === 'global' && artifacts.some((artifact) => artifact.type === 'hook')) {
      throw new Error('Hooks are project-only in V1.');
    }
    const targetAgents = await selectAgents(scope, artifacts);
    const selectedHooks = artifacts
      .filter(
        (artifact): artifact is Extract<Artifact, { type: 'hook' }> => artifact.type === 'hook'
      )
      .map((artifact) => artifact.hook);
    if (selectedHooks.length > 0 && artifacts.some((artifact) => artifact.type !== 'hook')) {
      p.log.message('Hook target agents are fixed by source format.');
    }
    await confirmHooks(selectedHooks);

    await installArtifacts(
      source,
      discovered.parsed,
      discovered.repoDir,
      artifacts,
      scope,
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./#-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commaList(values: string[]): string {
  return shellQuote(values.join(','));
}

function uniqueNames<T>(items: T[], getName: (item: T) => string): string[] {
  const counts = countByName(items, getName);
  return items
    .map(getName)
    .filter((name) => (counts.get(name.toLowerCase()) ?? 0) === 1)
    .sort(compareStrings);
}

function duplicateNames<T>(items: T[], getName: (item: T) => string): string[] {
  const counts = countByName(items, getName);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = getName(item);
    const key = name.toLowerCase();
    if ((counts.get(key) ?? 0) < 2 || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.sort(compareStrings);
}

function installCommand(
  source: string,
  discovered: Awaited<ReturnType<typeof discoverRepo>>
): string | null {
  const args = ['sloprider', 'install', shellQuote(source), '--scope', 'local', '--agents', 'all'];
  const skills = uniqueNames(discovered.skills, getSkillDisplayName);
  const mcps = uniqueNames(discovered.mcps, (server) => server.name);
  const hooks = uniqueNames(discovered.hooks, (hook) => hook.name);
  const plugins = uniqueNames(discovered.plugins, (plugin) => plugin.name);
  if (skills.length > 0) args.push('--skills', commaList(skills));
  if (mcps.length > 0) args.push('--mcps', commaList(mcps));
  if (hooks.length > 0) args.push('--hooks', commaList(hooks));
  if (plugins.length > 0) args.push('--plugins', commaList(plugins));
  if (skills.length === 0 && mcps.length === 0 && hooks.length === 0 && plugins.length === 0) {
    return null;
  }
  return args.join(' ');
}

function ambiguousArtifactNames(discovered: Awaited<ReturnType<typeof discoverRepo>>): string[] {
  return [
    ...duplicateNames(discovered.skills, getSkillDisplayName).map((name) => `skill: ${name}`),
    ...duplicateNames(discovered.mcps, (server) => server.name).map((name) => `mcp: ${name}`),
    ...duplicateNames(discovered.hooks, (hook) => hook.name).map((name) => `hook: ${name}`),
    ...duplicateNames(discovered.plugins, (plugin) => plugin.name).map((name) => `plugin: ${name}`),
  ];
}

function printInventory(
  source: string,
  discovered: Awaited<ReturnType<typeof discoverRepo>>
): void {
  console.log('');
  console.log(
    `Found ${discovered.skills.length} skill(s), ${discovered.mcps.length} MCP server(s), ${discovered.hooks.length} hook bundle(s), and ${discovered.plugins.length} plugin(s).`
  );

  if (discovered.skills.length > 0) {
    console.log('\nSkills:');
    for (const skill of discovered.skills) {
      const detail = skill.description ? ` - ${skill.description}` : '';
      console.log(
        `  ${getSkillDisplayName(skill)} - ${skillSourceLabel(discovered.repoDir, skill)}${detail}`
      );
    }
  }

  if (discovered.mcps.length > 0) {
    console.log('\nMCP servers:');
    for (const server of discovered.mcps) {
      const detail = displayMcp(server);
      console.log(`  ${server.name} - ${mcpSourceLabel(server)}${detail ? ` - ${detail}` : ''}`);
    }
  }

  if (discovered.hooks.length > 0) {
    console.log('\nHooks:');
    for (const hook of discovered.hooks) {
      console.log(`  ${hook.name} - ${formatHookAgent(hook.agent)} (${hook.events.join(', ')})`);
    }
  }

  if (discovered.plugins.length > 0) {
    console.log('\nPlugins:');
    for (const plugin of discovered.plugins) {
      const detail = plugin.description ? ` - ${plugin.description}` : '';
      console.log(`  ${plugin.name} - ${pluginSourceLabel(plugin)}${detail}`);
    }
  }

  if (
    discovered.skills.length > 0 ||
    discovered.mcps.length > 0 ||
    discovered.hooks.length > 0 ||
    discovered.plugins.length > 0
  ) {
    const command = installCommand(source, discovered);
    if (command) {
      console.log('\nInstall selected artifacts explicitly:');
      console.log(`  ${command}`);
    }
    const ambiguous = ambiguousArtifactNames(discovered);
    if (ambiguous.length > 0) {
      console.log('\nSome artifacts have duplicate names and require interactive selection:');
      for (const artifact of ambiguous) console.log(`  ${artifact}`);
    }
  }
}

export async function runDiscover(args: string[]): Promise<void> {
  const source = args[0];
  if (!source || args.length !== 1) {
    throw new Error('Usage: sloprider discover <git-url>');
  }

  let repoDir: string | null = null;
  try {
    p.intro(pc.bgCyan(pc.black(' sloprider discover ')));
    const discovered = await discoverRepo(source);
    repoDir = discovered.repoDir;

    if (
      discovered.skills.length === 0 &&
      discovered.mcps.length === 0 &&
      discovered.hooks.length === 0 &&
      discovered.plugins.length === 0
    ) {
      throw new Error('No skills, MCP servers, hook bundles, or plugins found in this repository.');
    }

    printInventory(source, discovered);
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
