import * as p from '@clack/prompts';
import { dirname, join, relative, sep } from 'path';
import pc from './colors.ts';
import { agents } from './agents.ts';
import { cleanupTempDir, cloneRepo, GitCloneError } from './git.ts';
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

type Scope = 'project' | 'global';
type Artifact = { type: 'skill'; skill: Skill } | { type: 'mcp'; server: DiscoveredMcpServer };

function isCancel(value: unknown): value is symbol {
  return typeof value === 'symbol';
}

function parseGitSource(input: string): ParsedSource {
  const parsed = parseSource(input);
  if (parsed.type === 'local') {
    throw new Error('discover expects a git URL, not a local path');
  }
  if (parsed.type === 'well-known') {
    return { ...parsed, type: 'git', url: input };
  }
  return parsed;
}

function displayMcp(server: DiscoveredMcpServer): string {
  if (server.transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return server.url ?? '';
}

function stripMcpMetadata(server: DiscoveredMcpServer): McpServer {
  const { sourcePath: _, ...next } = server;
  return next;
}

function relSkillPath(repoDir: string, skill: Skill): string {
  return relative(repoDir, join(skill.path, 'SKILL.md')).split(sep).join('/');
}

function selectableAgents(scope: Scope, artifacts: Artifact[]): AgentType[] {
  const hasSkill = artifacts.some((artifact) => artifact.type === 'skill');
  const hasMcp = artifacts.some((artifact) => artifact.type === 'mcp');
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

async function selectArtifacts(skills: Skill[], mcps: DiscoveredMcpServer[]): Promise<Artifact[]> {
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

function assertNoDuplicateNames(artifacts: Artifact[]): void {
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
}

export async function discoverRepo(source: string): Promise<{
  parsed: ParsedSource;
  repoDir: string;
  skills: Skill[];
  mcps: DiscoveredMcpServer[];
}> {
  const parsed = parseGitSource(source);
  const spinner = p.spinner();
  spinner.start('Cloning repository...');
  const repoDir = await cloneRepo(parsed.url, parsed.ref, {
    onProgress: (message) => spinner.message(`Cloning repository... ${message}`),
  });
  spinner.stop('Repository cloned');

  spinner.start('Scanning for skills and MCPs...');
  const base = parsed.subpath ? join(repoDir, parsed.subpath) : repoDir;
  const [skills, mcps] = await Promise.all([
    discoverSkills(repoDir, parsed.subpath),
    discoverMcpServers(base),
  ]);
  spinner.stop(`Found ${skills.length} skill(s) and ${mcps.length} MCP server(s)`);
  return { parsed, repoDir, skills, mcps };
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

async function install(
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

  if (installedSkillNames.size > 0) {
    p.log.success(`Installed ${installedSkillNames.size} skill(s)`);
    for (const name of installedSkillNames) p.log.message(`  ${pc.green('✓')} ${name}`);
  }
  if (installedMcpNames.size > 0) {
    p.log.success(`Installed ${installedMcpNames.size} MCP server(s)`);
    for (const name of installedMcpNames) p.log.message(`  ${pc.green('✓')} ${name}`);
  }
  if (failed.length > 0) {
    p.log.error(`Failed ${failed.length} install step(s)`);
    for (const line of failed) p.log.message(`  ${pc.red('✗')} ${line}`);
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

    if (discovered.skills.length === 0 && discovered.mcps.length === 0) {
      throw new Error('No skills or MCP servers found in this repository.');
    }

    const artifacts = await selectArtifacts(discovered.skills, discovered.mcps);
    assertNoDuplicateNames(artifacts);
    const scope = await selectScope();
    const targetAgents = await selectAgents(scope, artifacts);

    await install(source, discovered.parsed, discovered.repoDir, artifacts, scope, targetAgents);
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
