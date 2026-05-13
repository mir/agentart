import * as p from '@clack/prompts';
import { dirname, join, relative, sep } from 'path';
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
import { parseSource, getOwnerRepo } from './source-parser.ts';
import { addSkillToLock } from './skill-lock.ts';
import { addSkillToLocalLock, computeSkillFolderHash } from './local-lock.ts';
import { discoverSkills, getDuplicateSkillNameGroups, getSkillDisplayName } from './skills.ts';
import type { AgentType, ParsedSource, Skill } from './types.ts';
import type { McpServer } from './mcp-types.ts';

export type Scope = 'project' | 'global';
export type Artifact =
  | { type: 'skill'; skill: Skill }
  | { type: 'mcp'; server: DiscoveredMcpServer }
  | { type: 'hook'; hook: DiscoveredHookBundle };

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

export function relSkillPath(repoDir: string, skill: Skill): string {
  return relative(repoDir, join(skill.path, 'SKILL.md')).split(sep).join('/');
}

export function selectableAgents(scope: Scope, artifacts: Artifact[]): AgentType[] {
  const hasSkill = artifacts.some((artifact) => artifact.type === 'skill');
  const hasMcp = artifacts.some((artifact) => artifact.type === 'mcp');
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
  if (!hasSkill && hasMcp) {
    return names;
  }
  return names;
}

async function selectArtifacts(
  skills: Skill[],
  mcps: DiscoveredMcpServer[],
  hooks: DiscoveredHookBundle[]
): Promise<Artifact[]> {
  const choices = [
    ...skills.map((skill) => ({
      value: { type: 'skill' as const, skill },
      label: `skill: ${getSkillDisplayName(skill)}`,
      hint: skill.description,
    })),
    ...mcps.map((server) => ({
      value: { type: 'mcp' as const, server },
      label: `mcp: ${server.name}`,
      hint: `${displayMcp(server)} · ${server.sourcePath}`,
    })),
    ...hooks.map((hook) => ({
      value: { type: 'hook' as const, hook },
      label: `hook: ${hook.name} -> ${formatHookAgent(hook.agent)}`,
      hint: `${hook.events.join(', ')} · ${hook.sourcePath}`,
    })),
  ];

  const selected = await p.multiselect<Artifact>({
    message: `Select artifacts to install ${pc.dim('(space to toggle)')}`,
    options: choices,
    required: true,
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

export function assertNoDuplicateNames(artifacts: Artifact[]): void {
  const skills = artifacts
    .filter(
      (artifact): artifact is Extract<Artifact, { type: 'skill' }> => artifact.type === 'skill'
    )
    .map((artifact) => artifact.skill);
  const duplicateSkills = getDuplicateSkillNameGroups(skills);
  if (duplicateSkills.size > 0) {
    throw new Error(`Duplicate skill selected: ${[...duplicateSkills.keys()].join(', ')}`);
  }

  const mcpNames = new Set<string>();
  const duplicates = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'mcp') continue;
    const key = artifact.server.name.toLowerCase();
    if (mcpNames.has(key)) duplicates.add(artifact.server.name);
    mcpNames.add(key);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate MCP selected: ${[...duplicates].join(', ')}`);
  }

  const hookNamesByAgent = new Set<string>();
  const duplicateHooks = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.type !== 'hook') continue;
    const key = `${artifact.hook.agent}:${artifact.hook.name.toLowerCase()}`;
    if (hookNamesByAgent.has(key)) duplicateHooks.add(artifact.hook.name);
    hookNamesByAgent.add(key);
  }
  if (duplicateHooks.size > 0) {
    throw new Error(`Duplicate hook selected: ${[...duplicateHooks].join(', ')}`);
  }
}

export async function discoverRepo(source: string): Promise<{
  parsed: ParsedSource;
  repoDir: string;
  skills: Skill[];
  mcps: DiscoveredMcpServer[];
  hooks: DiscoveredHookBundle[];
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

  spinner.start('Scanning for skills, MCPs, and hooks...');
  const base = parsed.subpath ? join(repoDir, parsed.subpath) : repoDir;
  let skills: Skill[];
  let mcps: DiscoveredMcpServer[];
  let hooks: DiscoveredHookBundle[];
  try {
    [skills, mcps, hooks] = await Promise.all([
      discoverSkills(repoDir, parsed.subpath),
      discoverMcpServers(base),
      discoverHooks(base),
    ]);
    spinner.stop(
      `Found ${skills.length} skill(s), ${mcps.length} MCP server(s), and ${hooks.length} hook bundle(s)`
    );
  } catch (error) {
    spinner.stop('Failed to scan repository', 1);
    throw error;
  }
  return { parsed, repoDir, skills, mcps, hooks };
}

async function writeSkillLocks(
  scope: Scope,
  source: string,
  parsed: ParsedSource,
  repoDir: string,
  installedSkills: Skill[]
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
          pluginName: skill.pluginName,
        });
      } else {
        await addSkillToLocalLock(skill.name, {
          source: lockSource || source,
          sourceType: parsed.type,
          ref: parsed.ref,
          skillPath,
          computedHash: hash,
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
        },
        { global }
      );
    }
  }

  const installedSkills = skills.filter((skill) =>
    skillResults.some((entry) => entry.skill === skill && entry.result.success)
  );
  await writeSkillLocks(scope, source, parsed, repoDir, installedSkills);

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
        parsed.url.startsWith('git@') ? parsed.url : getOwnerRepo(parsed) || parsed.url
      )
    );
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
  if (failed.length > 0) {
    p.log.error(`Failed ${failed.length} install step(s)`);
    for (const line of failed) p.log.message(`  ${pc.red('✗')} ${line}`);
  }
}

export async function runInteractiveDiscover(args: string[]): Promise<void> {
  const source = args[0];
  if (!source || args.length !== 1) {
    throw new Error('Usage: agentart discover <git-url>');
  }

  let repoDir: string | null = null;
  try {
    p.intro(pc.bgCyan(pc.black(' agentart discover ')));
    const discovered = await discoverRepo(source);
    repoDir = discovered.repoDir;

    if (
      discovered.skills.length === 0 &&
      discovered.mcps.length === 0 &&
      discovered.hooks.length === 0
    ) {
      throw new Error('No skills, MCP servers, or hook bundles found in this repository.');
    }

    const artifacts = await selectArtifacts(discovered.skills, discovered.mcps, discovered.hooks);
    assertNoDuplicateNames(artifacts);
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

function installCommand(
  source: string,
  discovered: Awaited<ReturnType<typeof discoverRepo>>
): string {
  const args = ['agentart', 'install', shellQuote(source), '--scope', 'local', '--agents', 'all'];
  const skills = discovered.skills.map(getSkillDisplayName);
  const mcps = discovered.mcps.map((server) => server.name);
  const hooks = discovered.hooks.map((hook) => hook.name);
  if (skills.length > 0) args.push('--skills', commaList(skills));
  if (mcps.length > 0) args.push('--mcps', commaList(mcps));
  if (hooks.length > 0) args.push('--hooks', commaList(hooks));
  return args.join(' ');
}

function printInventory(
  source: string,
  discovered: Awaited<ReturnType<typeof discoverRepo>>
): void {
  console.log('');
  console.log(
    `Found ${discovered.skills.length} skill(s), ${discovered.mcps.length} MCP server(s), and ${discovered.hooks.length} hook bundle(s).`
  );

  if (discovered.skills.length > 0) {
    console.log('\nSkills:');
    for (const skill of discovered.skills) {
      const detail = skill.description ? ` - ${skill.description}` : '';
      console.log(`  ${getSkillDisplayName(skill)}${detail}`);
    }
  }

  if (discovered.mcps.length > 0) {
    console.log('\nMCP servers:');
    for (const server of discovered.mcps) {
      const detail = displayMcp(server);
      console.log(`  ${server.name}${detail ? ` - ${detail}` : ''}`);
    }
  }

  if (discovered.hooks.length > 0) {
    console.log('\nHooks:');
    for (const hook of discovered.hooks) {
      console.log(`  ${hook.name} - ${formatHookAgent(hook.agent)} (${hook.events.join(', ')})`);
    }
  }

  if (discovered.skills.length > 0 || discovered.mcps.length > 0 || discovered.hooks.length > 0) {
    console.log('\nInstall selected artifacts explicitly:');
    console.log(`  ${installCommand(source, discovered)}`);
  }
}

export async function runDiscover(args: string[]): Promise<void> {
  const source = args[0];
  if (!source || args.length !== 1) {
    throw new Error('Usage: agentart discover <git-url>');
  }

  let repoDir: string | null = null;
  try {
    p.intro(pc.bgCyan(pc.black(' agentart discover ')));
    const discovered = await discoverRepo(source);
    repoDir = discovered.repoDir;

    if (
      discovered.skills.length === 0 &&
      discovered.mcps.length === 0 &&
      discovered.hooks.length === 0
    ) {
      throw new Error('No skills, MCP servers, or hook bundles found in this repository.');
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
