import * as p from '@clack/prompts';
import pc from './colors.ts';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { sep, join, dirname } from 'path';
import { parseSource, getOwnerRepo } from './source-parser.ts';
import { searchMultiselect } from './prompts/search-multiselect.ts';

// Helper to check if a value is a cancel symbol (works with both clack and our custom prompts)
const isCancelled = (value: unknown): value is symbol => typeof value === 'symbol';

import { cloneRepo, cleanupTempDir, GitCloneError } from './git.ts';
import {
  discoverSkills,
  getSkillDisplayName,
  filterSkills,
  getDuplicateSkillNameGroups,
} from './skills.ts';
import {
  installSkillForAgent,
  installBlobSkillForAgent,
  isSkillInstalled,
  getCanonicalPath,
  installWellKnownSkillForAgent,
  type InstallMode,
} from './installer.ts';
import {
  detectInstalledAgents,
  agents,
  getUniversalAgents,
  getNonUniversalAgents,
  isUniversalAgent,
} from './agents.ts';
import { detectAgent, getAgentType } from './detect-agent.ts';
import { wellKnownProvider, type WellKnownSkill } from './providers/index.ts';
import {
  addSkillToLock,
  fetchSkillFolderHash,
  getGitHubToken,
  getLastSelectedAgents,
  saveSelectedAgents,
  type SkillLockEntry,
} from './skill-lock.ts';
import { addSkillToLocalLock, computeSkillFolderHash } from './local-lock.ts';
import type { Skill, AgentType, ParsedSource } from './types.ts';
import {
  tryBlobInstall,
  getSkillFolderHashFromTree,
  fetchRepoTree,
  type BlobSkill,
  type BlobInstallResult,
} from './blob.ts';
import { discoverMcpServers, type DiscoveredMcpServer } from './mcp-discovery.ts';
import { installMcpServerForAgent } from './mcp-config.ts';
import { addMcpToLock, type McpLockEntry } from './mcp-lock.ts';
import { getMcpCapableAgents, mcpAgents } from './mcp-agents.ts';
import {
  buildUpdateCommand,
  writeInstallMetadataToSkillDir,
  type InstallMetadata,
} from './skill-metadata.ts';

/**
 * Shortens a path for display: replaces homedir with ~ and cwd with .
 * Handles both Unix and Windows path separators.
 */
function shortenPath(fullPath: string, cwd: string): string {
  const home = homedir();
  // Ensure we match complete path segments by checking for separator after the prefix
  if (fullPath === home || fullPath.startsWith(home + sep)) {
    return '~' + fullPath.slice(home.length);
  }
  if (fullPath === cwd || fullPath.startsWith(cwd + sep)) {
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

/**
 * Splits agents into universal and non-universal (symlinked) groups.
 * Returns display names for each group.
 */
function splitAgentsByType(agentTypes: AgentType[]): {
  universal: string[];
  symlinked: string[];
} {
  const universal: string[] = [];
  const symlinked: string[] = [];

  for (const a of agentTypes) {
    if (isUniversalAgent(a)) {
      universal.push(agents[a].displayName);
    } else {
      symlinked.push(agents[a].displayName);
    }
  }

  return { universal, symlinked };
}

/**
 * Builds summary lines showing universal vs symlinked agents
 */
function buildAgentSummaryLines(targetAgents: AgentType[], installMode: InstallMode): string[] {
  const lines: string[] = [];
  const { universal, symlinked } = splitAgentsByType(targetAgents);

  if (installMode === 'symlink') {
    if (universal.length > 0) {
      lines.push(`  ${pc.green('universal:')} ${formatList(universal)}`);
    }
    if (symlinked.length > 0) {
      lines.push(`  ${pc.dim('symlink →')} ${formatList(symlinked)}`);
    }
  } else {
    // Copy mode - all agents get copies
    const allNames = targetAgents.map((a) => agents[a].displayName);
    lines.push(`  ${pc.dim('copy →')} ${formatList(allNames)}`);
  }

  return lines;
}

/**
 * Ensures universal agents are always included in the target agents list.
 * Used when -y flag is passed or when auto-selecting agents.
 */
function ensureUniversalAgents(targetAgents: AgentType[]): AgentType[] {
  const universalAgents = getUniversalAgents();
  const result = [...targetAgents];

  for (const ua of universalAgents) {
    if (!result.includes(ua)) {
      result.push(ua);
    }
  }

  return result;
}

/**
 * Builds result lines from installation results, splitting by universal vs symlinked
 */
function buildResultLines(
  results: Array<{
    agent: string;
    symlinkFailed?: boolean;
    skipped?: boolean;
  }>,
  targetAgents: AgentType[]
): string[] {
  const lines: string[] = [];

  // Split target agents by type
  const { universal, symlinked: symlinkAgents } = splitAgentsByType(targetAgents);

  // For symlink results, also track which ones actually succeeded vs failed
  // Exclude skipped agents (those whose config dir doesn't exist in the project)
  const successfulSymlinks = results
    .filter((r) => !r.symlinkFailed && !r.skipped && !universal.includes(r.agent))
    .map((r) => r.agent);
  const failedSymlinks = results.filter((r) => r.symlinkFailed && !r.skipped).map((r) => r.agent);

  if (universal.length > 0) {
    lines.push(`  ${pc.green('universal:')} ${formatList(universal)}`);
  }
  if (successfulSymlinks.length > 0) {
    lines.push(`  ${pc.dim('symlinked:')} ${formatList(successfulSymlinks)}`);
  }
  if (failedSymlinks.length > 0) {
    lines.push(`  ${pc.yellow('copied:')} ${formatList(failedSymlinks)}`);
  }

  return lines;
}

type InstalledResultForMetadata = {
  skill: string;
  success: boolean;
  path: string;
  canonicalPath?: string;
  mode: InstallMode;
  symlinkFailed?: boolean;
};

function getInstalledSkillDirs(results: InstalledResultForMetadata[], skillName: string): string[] {
  const dirs = new Set<string>();

  for (const result of results) {
    if (!result.success || result.skill !== skillName) continue;

    if (result.canonicalPath) {
      dirs.add(result.canonicalPath);
    }

    if (result.mode === 'copy' || result.symlinkFailed || !result.canonicalPath) {
      dirs.add(result.path);
    }
  }

  return [...dirs];
}

async function writeInstallMetadataForSkill(
  results: InstalledResultForMetadata[],
  skillName: string,
  metadata: InstallMetadata
): Promise<void> {
  const dirs = getInstalledSkillDirs(results, skillName);
  await Promise.all(
    dirs.map(async (dir) => {
      try {
        await writeInstallMetadataToSkillDir(dir, metadata);
      } catch {
        // Metadata is informational; never fail an otherwise successful install.
      }
    })
  );
}

function metadataFromLockEntry(entry: SkillLockEntry, updateCommand: string): InstallMetadata {
  return {
    source: entry.source,
    sourceType: entry.sourceType,
    sourceUrl: entry.sourceUrl,
    ref: entry.ref,
    skillPath: entry.skillPath,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    pluginName: entry.pluginName,
    updateCommand,
  };
}

/**
 * Wrapper around p.multiselect that adds a hint for keyboard usage.
 * Accepts options with required labels (matching our usage pattern).
 */
function multiselect<Value>(opts: {
  message: string;
  options: Array<{ value: Value; label: string; hint?: string }>;
  initialValues?: Value[];
  required?: boolean;
}) {
  return p.multiselect({
    ...opts,
    // Cast is safe: our options always have labels, which satisfies p.Option requirements
    options: opts.options as p.Option<Value>[],
    message: `${opts.message} ${pc.dim('(space to toggle)')}`,
  }) as Promise<Value[] | symbol>;
}

/**
 * Prompts the user to select agents using interactive search.
 * Pre-selects the last used agents if available.
 * Saves the selection for future use.
 */
export async function promptForAgents(
  message: string,
  choices: Array<{ value: AgentType; label: string; hint?: string }>
): Promise<AgentType[] | symbol> {
  // Get last selected agents to pre-select
  let lastSelected: string[] | undefined;
  try {
    lastSelected = await getLastSelectedAgents();
  } catch {
    // Silently ignore errors reading lock file
  }

  const validAgents = choices.map((c) => c.value);

  // Default agents to pre-select when no valid history exists
  const defaultAgents: AgentType[] = ['claude-code', 'opencode', 'codex'];
  const defaultValues = defaultAgents.filter((a) => validAgents.includes(a));

  let initialValues: AgentType[] = [];

  if (lastSelected && lastSelected.length > 0) {
    // Filter stored agents against currently valid agents
    initialValues = lastSelected.filter((a) => validAgents.includes(a as AgentType)) as AgentType[];
  }

  // If no valid selection from history, use defaults
  if (initialValues.length === 0) {
    initialValues = defaultValues;
  }

  const selected = await searchMultiselect({
    message,
    items: choices,
    initialSelected: initialValues,
    required: true,
  });

  if (!isCancelled(selected)) {
    // Save selection for next time
    try {
      await saveSelectedAgents(selected as string[]);
    } catch {
      // Silently ignore errors writing lock file
    }
  }

  return selected as AgentType[] | symbol;
}

/**
 * Interactive agent selection using fuzzy search.
 * Shows universal agents as locked (always selected), and other agents as selectable.
 */
async function selectAgentsInteractive(options: {
  global?: boolean;
}): Promise<AgentType[] | symbol> {
  // Filter out agents that don't support global installation when --global is used
  const supportsGlobalFilter = (a: AgentType) => !options.global || agents[a].globalSkillsDir;

  const universalAgents = getUniversalAgents().filter(supportsGlobalFilter);
  const otherAgents = getNonUniversalAgents().filter(supportsGlobalFilter);

  // Shared .agents/skills agents are shown as a locked section
  const universalSection = {
    title: 'Shared (.agents/skills)',
    items: universalAgents.map((a) => ({
      value: a,
      label: agents[a].displayName,
    })),
  };

  // Other agents are selectable with their skillsDir as hint
  const otherChoices = otherAgents.map((a) => ({
    value: a,
    label: agents[a].displayName,
    hint: options.global ? agents[a].globalSkillsDir! : agents[a].skillsDir,
  }));

  // Get last selected agents (filter to only non-universal ones for initial selection)
  let lastSelected: string[] | undefined;
  try {
    lastSelected = await getLastSelectedAgents();
  } catch {
    // Silently ignore errors
  }

  const initialSelected = lastSelected
    ? (lastSelected.filter(
        (a) => otherAgents.includes(a as AgentType) && !universalAgents.includes(a as AgentType)
      ) as AgentType[])
    : [];

  const selected = await searchMultiselect({
    message: 'Which agents do you want to install to?',
    items: otherChoices,
    initialSelected,
    lockedSection: universalSection,
  });

  if (!isCancelled(selected)) {
    // Save selection (all agents including universal)
    try {
      await saveSelectedAgents(selected as string[]);
    } catch {
      // Silently ignore errors
    }
  }

  return selected as AgentType[] | symbol;
}

export interface AddOptions {
  global?: boolean;
  agent?: string[];
  yes?: boolean;
  skill?: string[];
  mcp?: string[];
  noMcp?: boolean;
  list?: boolean;
  all?: boolean;
  fullDepth?: boolean;
  copy?: boolean;
}

type Spinner = ReturnType<typeof p.spinner>;

export interface CloneAndDiscoverResult {
  tempDir: string;
  skills: Skill[];
  discoveredMcps: DiscoveredMcpServer[];
}

function formatMcpCommandLine(server: DiscoveredMcpServer): string {
  if (server.transport === 'stdio') {
    return `${server.command}${server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}`;
  }
  return server.url || '';
}

function getMcpDisplayName(server: DiscoveredMcpServer): string {
  return `${server.sourcePath}:${server.name}`;
}

function stripDiscoveredMcpMetadata(server: DiscoveredMcpServer) {
  const { sourcePath: _, ...mcpServer } = server;
  return mcpServer;
}

function filterMcpServers(
  servers: DiscoveredMcpServer[],
  filters: string[]
): DiscoveredMcpServer[] {
  if (filters.includes('*')) return servers;

  const normalizedFilters = filters.map((filter) => filter.toLowerCase());
  return servers.filter((server) => {
    const name = server.name.toLowerCase();
    const displayName = getMcpDisplayName(server).toLowerCase();
    return normalizedFilters.some((filter) => filter === name || filter === displayName);
  });
}

function getDuplicateMcpNameGroups(
  servers: DiscoveredMcpServer[]
): Map<string, DiscoveredMcpServer[]> {
  const byName = new Map<string, DiscoveredMcpServer[]>();
  for (const server of servers) {
    const key = server.name.toLowerCase();
    const group = byName.get(key) || [];
    group.push(server);
    byName.set(key, group);
  }
  return new Map([...byName.entries()].filter(([_, group]) => group.length > 1));
}

async function selectMcpServers(
  servers: DiscoveredMcpServer[],
  options: AddOptions
): Promise<DiscoveredMcpServer[]> {
  if (options.noMcp) return [];

  if (servers.length === 0) {
    if (options.mcp && options.mcp.length > 0) {
      p.log.error('No MCP server definitions found.');
      process.exit(1);
    }
    return [];
  }

  if (options.mcp && options.mcp.length > 0) {
    const selected = filterMcpServers(servers, options.mcp);
    if (selected.length === 0) {
      p.log.error(`No matching MCP servers found for: ${options.mcp.join(', ')}`);
      p.log.info('Available MCP servers:');
      for (const server of servers) {
        p.log.message(`  - ${getMcpDisplayName(server)}`);
      }
      process.exit(1);
    }
    p.log.info(
      `Selected ${selected.length} MCP server${selected.length !== 1 ? 's' : ''}: ${selected.map((s) => pc.cyan(s.name)).join(', ')}`
    );
    return selected;
  }

  if (options.yes) {
    p.log.info(
      `Found ${servers.length} MCP server definition${servers.length === 1 ? '' : 's'}; pass ${pc.cyan("--mcp '*'")} to install them.`
    );
    return [];
  }

  const choices = servers.map((server) => ({
    value: server,
    label: server.name,
    hint: `${formatMcpCommandLine(server)} · ${server.sourcePath}`,
  }));

  const selected = await multiselect({
    message: 'Select MCP servers to install',
    options: choices,
    required: false,
  });

  if (p.isCancel(selected)) {
    p.cancel('Installation cancelled');
    process.exit(0);
  }

  return selected as DiscoveredMcpServer[];
}

export async function cloneAndDiscoverSkills(
  parsed: ParsedSource,
  options: AddOptions,
  spinner: Spinner,
  includeInternal: boolean
): Promise<CloneAndDiscoverResult> {
  spinner.start('Cloning repository...');
  const tempDir = await cloneRepo(parsed.url, parsed.ref, {
    onProgress: (message) => spinner.message(`Cloning repository... ${message}`),
  });
  spinner.stop('Repository cloned');

  spinner.start('Discovering skills...');
  const skills = await discoverSkills(tempDir, parsed.subpath, {
    includeInternal,
    fullDepth: options.fullDepth,
  });
  const discoveredMcps = await discoverMcpServers(
    parsed.subpath ? join(tempDir, parsed.subpath) : tempDir
  );

  return { tempDir, skills, discoveredMcps };
}

export function shouldFallbackToWellKnownAfterCloneError(error: unknown): boolean {
  return !(
    error instanceof GitCloneError &&
    (error.isAuthError || error.isTimeout || error.isCanceled)
  );
}

export function getWellKnownAttemptLines(gitUrl?: string): string[] {
  const lines: string[] = [];
  if (gitUrl) {
    lines.push(`- git clone ${gitUrl}`);
  }
  lines.push('- /.well-known/agent-skills/index.json');
  return lines;
}

export async function tryCloneAmbiguousHttpsSource(
  parsed: ParsedSource,
  options: AddOptions,
  spinner: Spinner,
  includeInternal: boolean
): Promise<CloneAndDiscoverResult | null> {
  try {
    const result = await cloneAndDiscoverSkills(
      { ...parsed, type: 'git', url: parsed.url },
      options,
      spinner,
      includeInternal
    );

    if (result.skills.length > 0 || (options.list && result.discoveredMcps.length > 0)) {
      return result;
    }

    spinner.stop(pc.dim('No skills found in cloned repository; trying well-known endpoint...'));
    await cleanup(result.tempDir);
    return null;
  } catch (error) {
    if (!shouldFallbackToWellKnownAfterCloneError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    spinner.stop(pc.dim(`Git clone failed; trying well-known endpoint... ${message}`));
    return null;
  }
}

/**
 * Handle skills from a well-known endpoint (RFC 8615).
 * Discovers skills from /.well-known/agent-skills/index.json.
 */
async function handleWellKnownSkills(
  source: string,
  url: string,
  options: AddOptions,
  spinner: Spinner,
  previousGitCloneUrl?: string
): Promise<void> {
  spinner.start('Discovering skills from well-known endpoint...');

  // Fetch all skills from the well-known endpoint
  const skills = await wellKnownProvider.fetchAllSkills(url);

  if (skills.length === 0) {
    spinner.stop(pc.red('No skills found'));
    if (previousGitCloneUrl) {
      p.outro(
        pc.red(
          `No skills found.\n\nTried:\n${getWellKnownAttemptLines(previousGitCloneUrl).join('\n')}`
        )
      );
    } else {
      p.outro(
        pc.red(
          'No skills found at this URL. Make sure the server has a /.well-known/agent-skills/index.json file.'
        )
      );
    }
    process.exit(1);
  }

  spinner.stop(`Found ${pc.green(skills.length)} skill${skills.length > 1 ? 's' : ''}`);

  // Log discovered skills
  for (const skill of skills) {
    p.log.info(`Skill: ${pc.cyan(skill.installName)}`);
    p.log.message(pc.dim(skill.description));
    if (skill.files.size > 1) {
      p.log.message(pc.dim(`  Files: ${Array.from(skill.files.keys()).join(', ')}`));
    }
  }

  if (options.list) {
    console.log();
    p.log.step(pc.bold('Available Skills'));
    for (const skill of skills) {
      p.log.message(`  ${pc.cyan(skill.installName)}`);
      p.log.message(`    ${pc.dim(skill.description)}`);
      if (skill.files.size > 1) {
        p.log.message(`    ${pc.dim(`Files: ${skill.files.size}`)}`);
      }
    }
    console.log();
    p.outro('Run without --list to install');
    process.exit(0);
  }

  // Filter skills if --skill option is provided
  let selectedSkills: WellKnownSkill[];

  if (options.skill?.includes('*')) {
    // --skill '*' selects all skills
    selectedSkills = skills;
    p.log.info(`Installing all ${skills.length} skills`);
  } else if (options.skill && options.skill.length > 0) {
    selectedSkills = skills.filter((s) =>
      options.skill!.some(
        (name) =>
          s.installName.toLowerCase() === name.toLowerCase() ||
          s.name.toLowerCase() === name.toLowerCase()
      )
    );

    if (selectedSkills.length === 0) {
      p.log.error(`No matching skills found for: ${options.skill.join(', ')}`);
      p.log.info('Available skills:');
      for (const s of skills) {
        p.log.message(`  - ${s.installName}`);
      }
      process.exit(1);
    }
  } else if (skills.length === 1) {
    selectedSkills = skills;
    const firstSkill = skills[0]!;
    p.log.info(`Skill: ${pc.cyan(firstSkill.installName)}`);
  } else if (options.yes) {
    selectedSkills = skills;
    p.log.info(`Installing all ${skills.length} skills`);
  } else {
    // Prompt user to select skills
    const skillChoices = skills.map((s) => ({
      value: s,
      label: s.installName,
      hint: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
    }));

    const selected = await multiselect({
      message: 'Select skills to install',
      options: skillChoices,
      required: true,
    });

    if (p.isCancel(selected)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    selectedSkills = selected as WellKnownSkill[];
  }

  // Detect agents
  let targetAgents: AgentType[];
  const validAgents = Object.keys(agents);

  if (options.agent?.includes('*')) {
    // --agent '*' selects all agents
    targetAgents = validAgents as AgentType[];
    p.log.info(`Installing to all ${targetAgents.length} agents`);
  } else if (options.agent && options.agent.length > 0) {
    const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

    if (invalidAgents.length > 0) {
      p.log.error(`Invalid agents: ${invalidAgents.join(', ')}`);
      p.log.info(`Valid agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }

    targetAgents = options.agent as AgentType[];
  } else {
    spinner.start('Loading agents...');
    const installedAgents = await detectInstalledAgents();
    const totalAgents = Object.keys(agents).length;
    spinner.stop(`${totalAgents} agents`);

    if (installedAgents.length === 0) {
      if (options.yes) {
        targetAgents = validAgents as AgentType[];
        p.log.info('Installing to all agents');
      } else {
        p.log.info('Select agents to install skills to');

        const allAgentChoices = Object.entries(agents).map(([key, config]) => ({
          value: key as AgentType,
          label: config.displayName,
        }));

        // Use helper to prompt with search
        const selected = await promptForAgents(
          'Which agents do you want to install to?',
          allAgentChoices
        );

        if (p.isCancel(selected)) {
          p.cancel('Installation cancelled');
          process.exit(0);
        }

        targetAgents = selected as AgentType[];
      }
    } else if (installedAgents.length === 1 || options.yes) {
      // Auto-select detected agents + ensure universal agents are included
      targetAgents = ensureUniversalAgents(installedAgents);
      if (installedAgents.length === 1) {
        const firstAgent = installedAgents[0]!;
        p.log.info(`Installing to: ${pc.cyan(agents[firstAgent].displayName)}`);
      } else {
        p.log.info(
          `Installing to: ${installedAgents.map((a) => pc.cyan(agents[a].displayName)).join(', ')}`
        );
      }
    } else {
      const selected = await selectAgentsInteractive({ global: options.global });

      if (p.isCancel(selected)) {
        p.cancel('Installation cancelled');
        process.exit(0);
      }

      targetAgents = selected as AgentType[];
    }
  }

  let installGlobally = options.global ?? false;

  // Check if any selected agents support global installation
  const supportsGlobal = targetAgents.some((a) => agents[a].globalSkillsDir !== undefined);

  if (options.global === undefined && !options.yes && supportsGlobal) {
    const scope = await p.select({
      message: 'Installation scope',
      options: [
        {
          value: false,
          label: 'Project',
          hint: 'Install in current directory (committed with your project)',
        },
        {
          value: true,
          label: 'Global',
          hint: 'Install in home directory (available across all projects)',
        },
      ],
    });

    if (p.isCancel(scope)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    installGlobally = scope as boolean;
  }

  // Determine install mode (symlink vs copy)
  let installMode: InstallMode = options.copy ? 'copy' : 'symlink';

  // Only prompt for install mode when there are multiple unique target directories.
  // When all selected agents share the same skillsDir, symlink vs copy is meaningless.
  const uniqueDirs = new Set(targetAgents.map((a) => agents[a].skillsDir));

  if (!options.copy && !options.yes && uniqueDirs.size > 1) {
    const modeChoice = await p.select({
      message: 'Installation method',
      options: [
        {
          value: 'symlink',
          label: 'Symlink (Recommended)',
          hint: 'Single source of truth, easy updates',
        },
        { value: 'copy', label: 'Copy to all agents', hint: 'Independent copies for each agent' },
      ],
    });

    if (p.isCancel(modeChoice)) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }

    installMode = modeChoice as InstallMode;
  } else if (uniqueDirs.size <= 1) {
    // Single target directory — default to copy (no symlink needed)
    installMode = 'copy';
  }

  const cwd = process.cwd();

  // Build installation summary
  const summaryLines: string[] = [];
  const agentNames = targetAgents.map((a) => agents[a].displayName);

  // Check if any skill will be overwritten (parallel)
  const overwriteChecks = await Promise.all(
    selectedSkills.flatMap((skill) =>
      targetAgents.map(async (agent) => ({
        skillName: skill.installName,
        agent,
        installed: await isSkillInstalled(skill.installName, agent, { global: installGlobally }),
      }))
    )
  );
  const overwriteStatus = new Map<string, Map<string, boolean>>();
  for (const { skillName, agent, installed } of overwriteChecks) {
    if (!overwriteStatus.has(skillName)) {
      overwriteStatus.set(skillName, new Map());
    }
    overwriteStatus.get(skillName)!.set(agent, installed);
  }

  for (const skill of selectedSkills) {
    if (summaryLines.length > 0) summaryLines.push('');

    const canonicalPath = getCanonicalPath(skill.installName, { global: installGlobally });
    const shortCanonical = shortenPath(canonicalPath, cwd);
    summaryLines.push(`${pc.cyan(shortCanonical)}`);
    summaryLines.push(...buildAgentSummaryLines(targetAgents, installMode));
    if (skill.files.size > 1) {
      summaryLines.push(`  ${pc.dim('files:')} ${skill.files.size}`);
    }

    const skillOverwrites = overwriteStatus.get(skill.installName);
    const overwriteAgents = targetAgents
      .filter((a) => skillOverwrites?.get(a))
      .map((a) => agents[a].displayName);

    if (overwriteAgents.length > 0) {
      summaryLines.push(`  ${pc.yellow('overwrites:')} ${formatList(overwriteAgents)}`);
    }
  }

  console.log();
  p.note(summaryLines.join('\n'), 'Installation Summary');

  if (!options.yes) {
    const confirmed = await p.confirm({ message: 'Proceed with installation?' });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Installation cancelled');
      process.exit(0);
    }
  }

  const sourceIdentifier = wellKnownProvider.getSourceIdentifier(url);

  spinner.start('Installing skills...');

  const results: {
    skill: string;
    agent: string;
    success: boolean;
    path: string;
    canonicalPath?: string;
    mode: InstallMode;
    symlinkFailed?: boolean;
    error?: string;
  }[] = [];

  for (const skill of selectedSkills) {
    for (const agent of targetAgents) {
      const result = await installWellKnownSkillForAgent(skill, agent, {
        global: installGlobally,
        mode: installMode,
      });
      results.push({
        skill: skill.installName,
        agent: agents[agent].displayName,
        ...result,
      });
    }
  }

  spinner.stop('Installation complete');

  console.log();
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const successfulSkillNames = new Set(successful.map((r) => r.skill));
  const now = new Date().toISOString();
  const installMetadataBySkill = new Map<string, InstallMetadata>();

  for (const skill of selectedSkills) {
    if (!successfulSkillNames.has(skill.installName)) continue;

    const updateCommand = buildUpdateCommand({
      skillName: skill.installName,
      global: installGlobally,
      sourceInput: source,
      canUseUpdateCommand: false,
    });

    installMetadataBySkill.set(skill.installName, {
      source: sourceIdentifier,
      sourceType: 'well-known',
      sourceUrl: skill.sourceUrl,
      installedAt: now,
      updatedAt: now,
      updateCommand,
    });
  }

  // Add to skill lock file for update tracking (only for global installs)
  if (successful.length > 0 && installGlobally) {
    for (const skill of selectedSkills) {
      if (successfulSkillNames.has(skill.installName)) {
        try {
          const entry = await addSkillToLock(skill.installName, {
            source: sourceIdentifier,
            sourceType: 'well-known',
            sourceUrl: skill.sourceUrl,
            skillFolderHash: '', // Well-known skills don't have a folder hash
          });
          const updateCommand =
            installMetadataBySkill.get(skill.installName)?.updateCommand ||
            buildUpdateCommand({
              skillName: skill.installName,
              global: installGlobally,
              sourceInput: source,
              canUseUpdateCommand: false,
            });
          installMetadataBySkill.set(
            skill.installName,
            metadataFromLockEntry(entry, updateCommand)
          );
        } catch {
          // Don't fail installation if lock file update fails
        }
      }
    }
  }

  // Add to local lock file for project-scoped installs
  if (successful.length > 0 && !installGlobally) {
    for (const skill of selectedSkills) {
      if (successfulSkillNames.has(skill.installName)) {
        try {
          const matchingResult = successful.find((r) => r.skill === skill.installName);
          const installDir = matchingResult?.canonicalPath || matchingResult?.path;
          if (installDir) {
            const computedHash = await computeSkillFolderHash(installDir);
            await addSkillToLocalLock(
              skill.installName,
              {
                source: sourceIdentifier,
                sourceType: 'well-known',
                computedHash,
              },
              cwd
            );
          }
        } catch {
          // Don't fail installation if lock file update fails
        }
      }
    }
  }

  await Promise.all(
    [...installMetadataBySkill.entries()].map(([skillName, metadata]) =>
      writeInstallMetadataForSkill(successful, skillName, metadata)
    )
  );

  if (successful.length > 0) {
    const bySkill = new Map<string, typeof results>();
    for (const r of successful) {
      const skillResults = bySkill.get(r.skill) || [];
      skillResults.push(r);
      bySkill.set(r.skill, skillResults);
    }

    const skillCount = bySkill.size;
    const symlinkFailures = successful.filter((r) => r.mode === 'symlink' && r.symlinkFailed);
    const copiedAgents = symlinkFailures.map((r) => r.agent);
    const resultLines: string[] = [];

    for (const [skillName, skillResults] of bySkill) {
      const firstResult = skillResults[0]!;

      if (firstResult.mode === 'copy') {
        // Copy mode: show skill name and list all agent paths
        resultLines.push(`${pc.green('✓')} ${skillName} ${pc.dim('(copied)')}`);
        for (const r of skillResults) {
          const shortPath = shortenPath(r.path, cwd);
          resultLines.push(`  ${pc.dim('→')} ${shortPath}`);
        }
      } else {
        // Symlink mode: show canonical path and universal/symlinked agents
        if (firstResult.canonicalPath) {
          const shortPath = shortenPath(firstResult.canonicalPath, cwd);
          resultLines.push(`${pc.green('✓')} ${shortPath}`);
        } else {
          resultLines.push(`${pc.green('✓')} ${skillName}`);
        }
        resultLines.push(...buildResultLines(skillResults, targetAgents));
      }
    }

    const title = pc.green(`Installed ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
    p.note(resultLines.join('\n'), title);

    // Show symlink failure warning (only for symlink mode)
    if (symlinkFailures.length > 0) {
      p.log.warn(pc.yellow(`Symlinks failed for: ${formatList(copiedAgents)}`));
      p.log.message(
        pc.dim(
          '  Files were copied instead. On Windows, enable Developer Mode for symlink support.'
        )
      );
    }
  }

  if (failed.length > 0) {
    console.log();
    p.log.error(pc.red(`Failed to install ${failed.length}`));
    for (const r of failed) {
      p.log.message(`  ${pc.red('✗')} ${r.skill} → ${r.agent}: ${pc.dim(r.error)}`);
    }
  }

  console.log();
  p.outro(
    pc.green('Done!') + pc.dim('  Review skills before use; they run with full agent permissions.')
  );
}

export async function runAdd(args: string[], options: AddOptions = {}): Promise<void> {
  const source = args[0];
  let installTipShown = false;

  const showInstallTip = (): void => {
    if (installTipShown) return;
    p.log.message(
      pc.dim('Tip: use the --yes (-y) and --global (-g) flags to install without prompts.')
    );
    installTipShown = true;
  };

  if (!source) {
    console.log();
    console.log(
      pc.bgRed(pc.white(pc.bold(' ERROR '))) + ' ' + pc.red('Missing required argument: source')
    );
    console.log();
    console.log(pc.dim('  Usage:'));
    console.log(`    ${pc.cyan('agentart add')} ${pc.yellow('<source>')} ${pc.dim('[options]')}`);
    console.log();
    console.log(pc.dim('  Example:'));
    console.log(`    ${pc.cyan('agentart add')} ${pc.yellow('vercel-labs/agent-skills')}`);
    console.log();
    process.exit(1);
  }

  // --all implies --skill '*' and --agent '*' and -y
  if (options.all) {
    options.skill = ['*'];
    options.agent = ['*'];
    options.yes = true;
  }

  // Auto-enable non-interactive mode when running inside an AI agent
  const agentResult = await detectAgent();
  if (agentResult.isAgent) {
    options.yes = true;
    // Auto-select the detected agent + universal agents (unless user explicitly specified agents)
    if (!options.agent || options.agent.length === 0) {
      const mappedAgent = getAgentType(agentResult.agent.name);
      if (mappedAgent) {
        options.agent = ensureUniversalAgents([mappedAgent]);
      }
    }
  }

  console.log();
  if (!agentResult.isAgent) {
    p.intro(pc.bgCyan(pc.black(' agentart ')));
  }

  if (agentResult.isAgent) {
    p.log.info(
      pc.bgCyan(pc.black(pc.bold(` ${agentResult.agent.name} `))) +
        ' ' +
        'Agent detected — installing non-interactively'
    );
  } else if (!process.stdin.isTTY) {
    showInstallTip();
  }

  let tempDir: string | null = null;

  try {
    const spinner = p.spinner();

    spinner.start('Parsing source...');
    const parsed = parseSource(source);
    let activeParsed = parsed;
    spinner.stop(
      `Source: ${parsed.type === 'local' ? parsed.localPath! : parsed.url}${parsed.ref ? ` @ ${pc.yellow(parsed.ref)}` : ''}${parsed.subpath ? ` (${parsed.subpath})` : ''}${parsed.skillFilter ? ` ${pc.dim('@')}${pc.cyan(parsed.skillFilter)}` : ''}`
    );

    // If skillFilter is present from @skill syntax (e.g., owner/repo@skill-name),
    // merge it into options.skill
    if (activeParsed.skillFilter) {
      options.skill = options.skill || [];
      if (!options.skill.includes(activeParsed.skillFilter)) {
        options.skill.push(activeParsed.skillFilter);
      }
    }

    // Include internal skills when a specific skill is explicitly requested
    // (via --skill or @skill syntax)
    const includeInternal = !!(options.skill && options.skill.length > 0);

    let skills: Skill[];
    let discoveredMcps: DiscoveredMcpServer[] = [];
    let blobResult: BlobInstallResult | null = null;

    if (parsed.type === 'well-known') {
      const cloneResult = await tryCloneAmbiguousHttpsSource(
        parsed,
        options,
        spinner,
        includeInternal
      );

      if (!cloneResult) {
        await handleWellKnownSkills(source, parsed.url, options, spinner, parsed.url);
        return;
      }

      activeParsed = { ...parsed, type: 'git', url: parsed.url };
      tempDir = cloneResult.tempDir;
      skills = cloneResult.skills;
      discoveredMcps = cloneResult.discoveredMcps;
    } else if (activeParsed.type === 'local') {
      // Use local path directly, no cloning needed
      spinner.start('Validating local path...');
      if (!existsSync(activeParsed.localPath!)) {
        spinner.stop(pc.red('Path not found'));
        p.outro(pc.red(`Local path does not exist: ${activeParsed.localPath}`));
        process.exit(1);
      }
      spinner.stop('Local path validated');

      spinner.start('Discovering skills...');
      skills = await discoverSkills(activeParsed.localPath!, activeParsed.subpath, {
        includeInternal,
        fullDepth: options.fullDepth,
      });
      discoveredMcps = await discoverMcpServers(
        activeParsed.subpath
          ? join(activeParsed.localPath!, activeParsed.subpath)
          : activeParsed.localPath!
      );
    } else if (
      activeParsed.type === 'github' &&
      !options.fullDepth &&
      !options.list &&
      (options.noMcp || (options.yes && !options.mcp))
    ) {
      // Try blob-based fast install for GitHub sources
      // Only enabled for allowlisted orgs; skip for --full-depth
      // Also skip when MCP discovery may affect the install selection.
      const BLOB_ALLOWED_OWNERS = ['vercel', 'vercel-labs', 'heygen-com'];
      const ownerRepo = getOwnerRepo(activeParsed);
      const owner = ownerRepo?.split('/')[0]?.toLowerCase();
      if (ownerRepo && owner && BLOB_ALLOWED_OWNERS.includes(owner)) {
        spinner.start('Fetching skills...');
        const token = getGitHubToken();
        blobResult = await tryBlobInstall(ownerRepo, {
          subpath: activeParsed.subpath,
          skillFilter: activeParsed.skillFilter,
          ref: activeParsed.ref,
          token,
          includeInternal,
        });
        if (!blobResult) {
          spinner.stop(pc.dim('Falling back to clone...'));
        }
      }

      if (blobResult) {
        skills = blobResult.skills;
        spinner.stop(`Found ${pc.green(skills.length)} skill${skills.length > 1 ? 's' : ''}`);
      } else {
        // Blob failed — fall back to git clone
        const cloneResult = await cloneAndDiscoverSkills(
          activeParsed,
          options,
          spinner,
          includeInternal
        );
        tempDir = cloneResult.tempDir;
        skills = cloneResult.skills;
        discoveredMcps = cloneResult.discoveredMcps;
      }
    } else {
      // GitLab, git URL, or --full-depth: always clone
      const cloneResult = await cloneAndDiscoverSkills(
        activeParsed,
        options,
        spinner,
        includeInternal
      );
      tempDir = cloneResult.tempDir;
      skills = cloneResult.skills;
      discoveredMcps = cloneResult.discoveredMcps;
    }

    if (skills.length === 0 && discoveredMcps.length === 0) {
      spinner.stop(pc.red('No skills found and no MCP servers found'));
      p.outro(
        pc.red(
          'No valid skills found and no MCP server definitions found. Skills require a SKILL.md with name and description.'
        )
      );
      await cleanup(tempDir);
      process.exit(1);
    }

    if (!blobResult) {
      spinner.stop(`Found ${pc.green(skills.length)} skill${skills.length > 1 ? 's' : ''}`);
    }

    if (options.list) {
      console.log();
      if (skills.length > 0) {
        p.log.step(pc.bold('Available Skills'));

        // Group available skills by plugin for list output
        const groupedSkills: Record<string, Skill[]> = {};
        const ungroupedSkills: Skill[] = [];

        for (const skill of skills) {
          if (skill.pluginName) {
            const group = skill.pluginName;
            if (!groupedSkills[group]) groupedSkills[group] = [];
            groupedSkills[group].push(skill);
          } else {
            ungroupedSkills.push(skill);
          }
        }

        // Print groups
        const sortedGroups = Object.keys(groupedSkills).sort();
        for (const group of sortedGroups) {
          // Convert kebab-case to Title Case for display header
          const title = group
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

          console.log(pc.bold(title));
          for (const skill of groupedSkills[group]!) {
            p.log.message(`  ${pc.cyan(getSkillDisplayName(skill))}`);
            p.log.message(`    ${pc.dim(skill.description)}`);
            p.log.message(`    ${pc.dim(shortenPath(skill.path, process.cwd()))}`);
          }
          console.log();
        }

        // Print ungrouped
        if (ungroupedSkills.length > 0) {
          if (sortedGroups.length > 0) console.log(pc.bold('General'));
          for (const skill of ungroupedSkills) {
            p.log.message(`  ${pc.cyan(getSkillDisplayName(skill))}`);
            p.log.message(`    ${pc.dim(skill.description)}`);
            if (skill.path) p.log.message(`    ${pc.dim(shortenPath(skill.path, process.cwd()))}`);
          }
        }
      }

      if (discoveredMcps.length > 0) {
        console.log();
        p.log.step(pc.bold('Available MCP Servers'));
        for (const server of discoveredMcps) {
          const commandLine =
            server.transport === 'stdio'
              ? `${server.command}${server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}`
              : server.url || '';
          p.log.message(`  ${pc.cyan(server.name)} ${pc.dim(`(${server.sourcePath})`)}`);
          p.log.message(`    ${pc.dim(commandLine)}`);
        }
      }

      console.log();
      if (skills.length > 0 && discoveredMcps.length > 0) {
        p.outro('Use --skill <name> or --mcp <name> to install specific items');
      } else if (discoveredMcps.length > 0) {
        p.outro('Use --mcp <name> to install specific MCP servers');
      } else {
        p.outro('Use --skill <name> to install specific skills');
      }
      await cleanup(tempDir);
      process.exit(0);
    }

    const duplicateSkillNames = new Set(getDuplicateSkillNameGroups(skills).keys());
    const skillChoiceHint = (skill: Skill) => {
      const description =
        skill.description.length > 60 ? skill.description.slice(0, 57) + '...' : skill.description;
      if (!duplicateSkillNames.has(skill.name.toLowerCase()) || !skill.path) {
        return description;
      }
      return `${description} · ${shortenPath(skill.path, process.cwd())}`;
    };

    let selectedSkills: Skill[] = [];

    if (skills.length === 0) {
      selectedSkills = [];
    } else if (options.skill?.includes('*')) {
      // --skill '*' selects all skills
      selectedSkills = skills;
      p.log.info(`Installing all ${skills.length} skills`);
    } else if (options.skill && options.skill.length > 0) {
      selectedSkills = filterSkills(skills, options.skill);

      if (selectedSkills.length === 0) {
        p.log.error(`No matching skills found for: ${options.skill.join(', ')}`);
        p.log.info('Available skills:');
        for (const s of skills) {
          p.log.message(`  - ${getSkillDisplayName(s)}`);
        }
        await cleanup(tempDir);
        process.exit(1);
      }

      p.log.info(
        `Selected ${selectedSkills.length} skill${selectedSkills.length !== 1 ? 's' : ''}: ${selectedSkills.map((s) => pc.cyan(getSkillDisplayName(s))).join(', ')}`
      );
    } else if (skills.length === 1) {
      selectedSkills = skills;
      const firstSkill = skills[0]!;
      p.log.info(`Skill: ${pc.cyan(getSkillDisplayName(firstSkill))}`);
      p.log.message(pc.dim(firstSkill.description));
    } else if (options.yes) {
      selectedSkills = skills;
      p.log.info(`Installing all ${skills.length} skills`);
    } else {
      // Sort skills by plugin name first, then by skill name
      const sortedSkills = [...skills].sort((a, b) => {
        if (a.pluginName && !b.pluginName) return -1;
        if (!a.pluginName && b.pluginName) return 1;
        if (a.pluginName && b.pluginName && a.pluginName !== b.pluginName) {
          return a.pluginName.localeCompare(b.pluginName);
        }
        return getSkillDisplayName(a).localeCompare(getSkillDisplayName(b));
      });

      // Check if any skills have plugin grouping
      const hasGroups = sortedSkills.some((s) => s.pluginName);

      let selected: Skill[] | symbol;

      if (hasGroups) {
        // Build grouped options for groupMultiselect
        const kebabToTitle = (s: string) =>
          s
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        const grouped: Record<string, p.Option<Skill>[]> = {};
        for (const s of sortedSkills) {
          const groupName = s.pluginName ? kebabToTitle(s.pluginName) : 'Other';
          if (!grouped[groupName]) grouped[groupName] = [];
          grouped[groupName]!.push({
            value: s,
            label: getSkillDisplayName(s),
            hint: skillChoiceHint(s),
          });
        }

        selected = await p.groupMultiselect({
          message: `Select skills to install ${pc.dim('(space to toggle)')}`,
          options: grouped,
          required: true,
        });
      } else {
        const skillChoices = sortedSkills.map((s) => ({
          value: s,
          label: getSkillDisplayName(s),
          hint: skillChoiceHint(s),
        }));

        selected = await multiselect({
          message: 'Select skills to install',
          options: skillChoices,
          required: true,
        });
      }

      if (p.isCancel(selected)) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }

      selectedSkills = selected as Skill[];
    }

    const selectedMcps = await selectMcpServers(discoveredMcps, options);

    const selectedDuplicateGroups = getDuplicateSkillNameGroups(selectedSkills);
    if (selectedDuplicateGroups.size > 0) {
      p.log.error('Duplicate skill names selected. Install one conflicting path at a time.');
      for (const [name, group] of selectedDuplicateGroups) {
        p.log.message(`  ${pc.cyan(name)}`);
        for (const skill of group) {
          p.log.message(`    ${pc.dim(shortenPath(skill.path, process.cwd()))}`);
        }
      }
      await cleanup(tempDir);
      process.exit(1);
    }

    const selectedDuplicateMcpGroups = getDuplicateMcpNameGroups(selectedMcps);
    if (selectedDuplicateMcpGroups.size > 0) {
      p.log.error('Duplicate MCP server names selected. Install one conflicting path at a time.');
      for (const [name, group] of selectedDuplicateMcpGroups) {
        p.log.message(`  ${pc.cyan(name)}`);
        for (const server of group) {
          p.log.message(`    ${pc.dim(server.sourcePath)}`);
        }
      }
      await cleanup(tempDir);
      process.exit(1);
    }

    if (selectedSkills.length === 0 && selectedMcps.length === 0) {
      if (discoveredMcps.length > 0 && options.yes) {
        p.outro(pc.red(`No skills selected. Pass ${pc.cyan("--mcp '*'")} to install MCP servers.`));
        await cleanup(tempDir);
        process.exit(1);
      }
      p.outro(pc.dim('Nothing selected for installation.'));
      await cleanup(tempDir);
      process.exit(0);
    }

    let targetAgents: AgentType[];
    const installingSkills = selectedSkills.length > 0;
    const validAgents = installingSkills
      ? Object.keys(agents)
      : getMcpCapableAgents({ global: options.global });

    if (options.agent?.includes('*')) {
      // --agent '*' selects all agents
      targetAgents = validAgents as AgentType[];
      p.log.info(`Installing to all ${targetAgents.length} agents`);
    } else if (options.agent && options.agent.length > 0) {
      const invalidAgents = options.agent.filter((a) => !validAgents.includes(a));

      if (invalidAgents.length > 0) {
        p.log.error(`Invalid agents: ${invalidAgents.join(', ')}`);
        p.log.info(`Valid agents: ${validAgents.join(', ')}`);
        await cleanup(tempDir);
        process.exit(1);
      }

      targetAgents = options.agent as AgentType[];
    } else {
      spinner.start('Loading agents...');
      const installedAgents = (await detectInstalledAgents()).filter((agent) =>
        (validAgents as string[]).includes(agent)
      );
      const totalAgents = Object.keys(agents).length;
      spinner.stop(`${totalAgents} agents`);

      if (installedAgents.length === 0) {
        if (options.yes) {
          targetAgents = validAgents as AgentType[];
          p.log.info('Installing to all agents');
        } else {
          p.log.info(`Select agents to install ${installingSkills ? 'skills' : 'MCP servers'} to`);

          const allAgentChoices = validAgents.map((key) => ({
            value: key as AgentType,
            label: agents[key as AgentType].displayName,
          }));

          // Use helper to prompt with search
          const selected = await promptForAgents(
            'Which agents do you want to install to?',
            allAgentChoices
          );

          if (p.isCancel(selected)) {
            p.cancel('Installation cancelled');
            await cleanup(tempDir);
            process.exit(0);
          }

          targetAgents = selected as AgentType[];
        }
      } else if (installedAgents.length === 1 || options.yes) {
        // Auto-select detected agents + ensure universal agents are included
        targetAgents = ensureUniversalAgents(installedAgents);
        if (!installingSkills) {
          targetAgents = targetAgents.filter((agent) => (validAgents as string[]).includes(agent));
        }
        if (installedAgents.length === 1) {
          const firstAgent = installedAgents[0]!;
          p.log.info(`Installing to: ${pc.cyan(agents[firstAgent].displayName)}`);
        } else {
          p.log.info(
            `Installing to: ${installedAgents.map((a) => pc.cyan(agents[a].displayName)).join(', ')}`
          );
        }
      } else {
        let selected: AgentType[] | symbol;
        if (installingSkills) {
          selected = await selectAgentsInteractive({ global: options.global });
        } else {
          selected = await promptForAgents(
            'Which agents do you want to install MCP servers to?',
            validAgents.map((key) => ({
              value: key as AgentType,
              label:
                mcpAgents[key as AgentType]?.displayName ?? agents[key as AgentType].displayName,
            }))
          );
        }

        if (p.isCancel(selected)) {
          p.cancel('Installation cancelled');
          await cleanup(tempDir);
          process.exit(0);
        }

        targetAgents = selected as AgentType[];
      }
    }

    let installGlobally = options.global ?? false;

    // Check if any selected agents support global installation
    const supportsGlobal = installingSkills
      ? targetAgents.some((a) => agents[a].globalSkillsDir !== undefined)
      : targetAgents.some((a) => mcpAgents[a]?.globalPath !== undefined);

    if (options.global === undefined && !options.yes && supportsGlobal) {
      const scope = await p.select({
        message: 'Installation scope',
        options: [
          {
            value: false,
            label: 'Project',
            hint: 'Install in current directory (committed with your project)',
          },
          {
            value: true,
            label: 'Global',
            hint: 'Install in home directory (available across all projects)',
          },
        ],
      });

      if (p.isCancel(scope)) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }

      installGlobally = scope as boolean;
    }

    const mcpCapableAgents = getMcpCapableAgents({ global: installGlobally });
    const targetMcpAgents = selectedMcps.length
      ? targetAgents.filter((agent) => mcpCapableAgents.includes(agent))
      : [];

    if (selectedMcps.length > 0 && targetMcpAgents.length === 0) {
      p.log.error('Selected agents do not support MCP configuration.');
      p.log.info(`MCP-capable agents: ${mcpCapableAgents.join(', ')}`);
      await cleanup(tempDir);
      process.exit(1);
    }

    // Determine install mode (symlink vs copy)
    let installMode: InstallMode = options.copy ? 'copy' : 'symlink';

    // Only prompt for install mode when there are multiple unique target directories.
    // When all selected agents share the same skillsDir, symlink vs copy is meaningless.
    const uniqueDirs = new Set(targetAgents.map((a) => agents[a].skillsDir));

    if (installingSkills && !options.copy && !options.yes && uniqueDirs.size > 1) {
      const modeChoice = await p.select({
        message: 'Installation method',
        options: [
          {
            value: 'symlink',
            label: 'Symlink (Recommended)',
            hint: 'Single source of truth, easy updates',
          },
          { value: 'copy', label: 'Copy to all agents', hint: 'Independent copies for each agent' },
        ],
      });

      if (p.isCancel(modeChoice)) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }

      installMode = modeChoice as InstallMode;
    } else if (!installingSkills || uniqueDirs.size <= 1) {
      // Single target directory — default to copy (no symlink needed)
      installMode = 'copy';
    }

    const cwd = process.cwd();

    // Build installation summary
    const summaryLines: string[] = [];
    // Check if any skill will be overwritten (parallel)
    const overwriteChecks = await Promise.all(
      selectedSkills.flatMap((skill) =>
        targetAgents.map(async (agent) => ({
          skillName: skill.name,
          agent,
          installed: await isSkillInstalled(skill.name, agent, { global: installGlobally }),
        }))
      )
    );
    const overwriteStatus = new Map<string, Map<string, boolean>>();
    for (const { skillName, agent, installed } of overwriteChecks) {
      if (!overwriteStatus.has(skillName)) {
        overwriteStatus.set(skillName, new Map());
      }
      overwriteStatus.get(skillName)!.set(agent, installed);
    }

    // Group selected skills for summary
    const groupedSummary: Record<string, Skill[]> = {};
    const ungroupedSummary: Skill[] = [];

    for (const skill of selectedSkills) {
      if (skill.pluginName) {
        const group = skill.pluginName;
        if (!groupedSummary[group]) groupedSummary[group] = [];
        groupedSummary[group].push(skill);
      } else {
        ungroupedSummary.push(skill);
      }
    }

    // Helper to print summary lines for a list of skills
    const printSkillSummary = (skills: Skill[]) => {
      for (const skill of skills) {
        if (summaryLines.length > 0) summaryLines.push('');

        const canonicalPath = getCanonicalPath(skill.name, { global: installGlobally });
        const shortCanonical = shortenPath(canonicalPath, cwd);
        summaryLines.push(`${pc.cyan(shortCanonical)}`);
        summaryLines.push(...buildAgentSummaryLines(targetAgents, installMode));

        const skillOverwrites = overwriteStatus.get(skill.name);
        const overwriteAgents = targetAgents
          .filter((a) => skillOverwrites?.get(a))
          .map((a) => agents[a].displayName);

        if (overwriteAgents.length > 0) {
          summaryLines.push(`  ${pc.yellow('overwrites:')} ${formatList(overwriteAgents)}`);
        }
      }
    };

    // Build grouped summary
    const sortedGroups = Object.keys(groupedSummary).sort();

    for (const group of sortedGroups) {
      const title = group
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      summaryLines.push('');
      summaryLines.push(pc.bold(title));
      printSkillSummary(groupedSummary[group]!);
    }

    if (ungroupedSummary.length > 0) {
      if (sortedGroups.length > 0) {
        summaryLines.push('');
        summaryLines.push(pc.bold('General'));
      }
      printSkillSummary(ungroupedSummary);
    }

    if (selectedMcps.length > 0) {
      if (summaryLines.length > 0) summaryLines.push('');
      summaryLines.push(pc.bold('MCP Servers'));
      for (const server of selectedMcps) {
        if (summaryLines.length > 0) summaryLines.push('');
        summaryLines.push(`${pc.cyan(server.name)} ${pc.dim(`(${server.sourcePath})`)}`);
        summaryLines.push(`  ${pc.dim(formatMcpCommandLine(server))}`);
        summaryLines.push(
          `  ${pc.dim('mcp →')} ${formatList(
            targetMcpAgents.map(
              (agent) => mcpAgents[agent]?.displayName ?? agents[agent].displayName
            )
          )}`
        );
      }
    }

    console.log();
    p.note(summaryLines.join('\n'), 'Installation Summary');

    if (!options.yes) {
      const confirmed = await p.confirm({ message: 'Proceed with installation?' });

      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel('Installation cancelled');
        await cleanup(tempDir);
        process.exit(0);
      }
    }

    // Normalize source to owner/repo format
    const normalizedSource = getOwnerRepo(activeParsed);

    // Preserve SSH URLs in lock files instead of normalizing to owner/repo shorthand.
    // When normalizedSource is used, parseSource() later resolves it to HTTPS,
    // breaking restore for private repos that require SSH authentication.
    const isSSH = activeParsed.url.startsWith('git@');
    const lockSource = isSSH ? activeParsed.url : normalizedSource;

    const results: {
      skill: string;
      agent: string;
      success: boolean;
      path: string;
      canonicalPath?: string;
      mode: InstallMode;
      symlinkFailed?: boolean;
      error?: string;
      pluginName?: string;
    }[] = [];

    if (selectedSkills.length > 0) {
      spinner.start('Installing skills...');

      for (const skill of selectedSkills) {
        for (const agent of targetAgents) {
          let result;
          if (blobResult && 'files' in skill) {
            // Blob-based install: write files from snapshot
            const blobSkill = skill as BlobSkill;
            result = await installBlobSkillForAgent(
              { installName: blobSkill.name, files: blobSkill.files },
              agent,
              { global: installGlobally, mode: installMode }
            );
          } else {
            // Disk-based install: copy from cloned/local directory
            result = await installSkillForAgent(skill, agent, {
              global: installGlobally,
              mode: installMode,
            });
          }
          results.push({
            skill: getSkillDisplayName(skill),
            agent: agents[agent].displayName,
            pluginName: skill.pluginName,
            ...result,
          });
        }
      }

      spinner.stop('Skill installation complete');
    }

    const mcpResults: {
      server: string;
      agent: string;
      success: boolean;
      path: string;
      error?: string;
    }[] = [];

    if (selectedMcps.length > 0) {
      spinner.start('Installing MCP servers...');

      for (const discoveredMcp of selectedMcps) {
        const server = stripDiscoveredMcpMetadata(discoveredMcp);
        const serverResults: typeof mcpResults = [];

        for (const agent of targetMcpAgents) {
          const result = await installMcpServerForAgent(server, agent, {
            global: installGlobally,
            cwd,
          });
          const entry = {
            server: server.name,
            agent: mcpAgents[agent]?.displayName ?? agents[agent].displayName,
            ...result,
          };
          mcpResults.push(entry);
          serverResults.push(entry);
        }

        if (serverResults.every((result) => result.success)) {
          try {
            const sourceForMcpLock = lockSource || normalizedSource || activeParsed.url;
            await addMcpToLock(
              server,
              {
                source: sourceForMcpLock,
                sourceType: activeParsed.type as McpLockEntry['sourceType'],
              },
              { global: installGlobally, cwd }
            );
          } catch {
            // Don't fail installation if lock file update fails
          }
        }
      }

      spinner.stop('MCP installation complete');
    }

    console.log();
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);
    // Track installation result
    // Build skillFiles map: { skillName: relative path to SKILL.md from repo root }
    const skillFiles: Record<string, string> = {};
    for (const skill of selectedSkills) {
      if (blobResult && 'repoPath' in skill) {
        // Blob-based: repoPath is already the repo-relative path (e.g., "skills/react/SKILL.md")
        skillFiles[skill.name] = (skill as BlobSkill).repoPath;
      } else if (tempDir && skill.path === tempDir) {
        // Skill is at root level of repo
        skillFiles[skill.name] = 'SKILL.md';
      } else if (tempDir && skill.path.startsWith(tempDir + sep)) {
        // Compute path relative to repo root (tempDir), not search path
        // Use forward slashes (URL-style paths)
        skillFiles[skill.name] =
          skill.path
            .slice(tempDir.length + 1)
            .split(sep)
            .join('/') + '/SKILL.md';
      } else {
        // Local path - skip the event hook for local installs
        continue;
      }
    }

    const successfulSkillNames = new Set(successful.map((r) => r.skill));
    const now = new Date().toISOString();
    const installMetadataBySkill = new Map<string, InstallMetadata>();

    for (const skill of selectedSkills) {
      const skillDisplayName = getSkillDisplayName(skill);
      if (!successfulSkillNames.has(skillDisplayName)) continue;

      const skillPathValue = skillFiles[skill.name];
      const sourceForMetadata = lockSource || normalizedSource || activeParsed.url;
      const canUseUpdateCommand = activeParsed.type === 'github' && !!skillPathValue;
      const updateCommand = buildUpdateCommand({
        skillName: skill.name,
        global: installGlobally,
        sourceInput: activeParsed.type === 'local' ? activeParsed.url : source,
        canUseUpdateCommand,
      });

      installMetadataBySkill.set(skill.name, {
        source: sourceForMetadata,
        sourceType: activeParsed.type,
        sourceUrl: activeParsed.url,
        ref: activeParsed.ref,
        skillPath: skillPathValue,
        installedAt: now,
        updatedAt: now,
        pluginName: skill.pluginName,
        updateCommand,
      });
    }

    // Add to skill lock file for update tracking (only for global installs)
    if (successful.length > 0 && installGlobally && normalizedSource) {
      // For GitHub clone installs, fetch the repo tree once and reuse it
      // for all skills — avoids N sequential API calls that take ~400ms each.
      let cachedTree: Awaited<ReturnType<typeof fetchRepoTree>> | undefined;
      if (activeParsed.type === 'github' && !blobResult) {
        const token = getGitHubToken();
        cachedTree = await fetchRepoTree(normalizedSource, activeParsed.ref, token);
      }

      for (const skill of selectedSkills) {
        const skillDisplayName = getSkillDisplayName(skill);
        if (successfulSkillNames.has(skillDisplayName)) {
          try {
            let skillFolderHash = '';
            const skillPathValue = skillFiles[skill.name];

            if (blobResult && skillPathValue) {
              const hash = getSkillFolderHashFromTree(blobResult.tree, skillPathValue);
              if (hash) skillFolderHash = hash;
            } else if (activeParsed.type === 'github' && skillPathValue && cachedTree) {
              const hash = getSkillFolderHashFromTree(cachedTree, skillPathValue);
              if (hash) skillFolderHash = hash;
            } else if (skillPathValue && tempDir) {
              const skillDir = join(tempDir, dirname(skillPathValue));
              const hash = await computeSkillFolderHash(skillDir);
              if (hash) skillFolderHash = hash;
            }

            const entry = await addSkillToLock(skill.name, {
              source: lockSource || normalizedSource,
              sourceType: activeParsed.type,
              sourceUrl: activeParsed.url,
              ref: activeParsed.ref,
              skillPath: skillPathValue,
              skillFolderHash,
              pluginName: skill.pluginName,
            });
            const updateCommand =
              installMetadataBySkill.get(skill.name)?.updateCommand ||
              buildUpdateCommand({
                skillName: skill.name,
                global: installGlobally,
                sourceInput: activeParsed.type === 'local' ? activeParsed.url : source,
                canUseUpdateCommand: activeParsed.type === 'github' && !!skillPathValue,
              });
            installMetadataBySkill.set(skill.name, metadataFromLockEntry(entry, updateCommand));
          } catch {
            // Don't fail installation if lock file update fails
          }
        }
      }
    }

    // Add to local lock file for project-scoped installs
    if (successful.length > 0 && !installGlobally) {
      for (const skill of selectedSkills) {
        const skillDisplayName = getSkillDisplayName(skill);
        if (successfulSkillNames.has(skillDisplayName)) {
          try {
            // For blob skills, use the snapshot hash; for disk skills, compute from files
            const computedHash =
              blobResult && 'snapshotHash' in skill
                ? (skill as BlobSkill).snapshotHash
                : await computeSkillFolderHash(skill.path);
            const skillPathValue = skillFiles[skill.name];
            await addSkillToLocalLock(
              skill.name,
              {
                source: lockSource || activeParsed.url,
                ref: activeParsed.ref,
                sourceType: activeParsed.type,
                ...(skillPathValue && { skillPath: skillPathValue }),
                computedHash,
              },
              cwd
            );
          } catch {
            // Don't fail installation if lock file update fails
          }
        }
      }
    }

    await Promise.all(
      [...installMetadataBySkill.entries()].map(([skillName, metadata]) =>
        writeInstallMetadataForSkill(successful, skillName, metadata)
      )
    );

    if (successful.length > 0) {
      const bySkill = new Map<string, typeof results>();

      // Group results by plugin name
      const groupedResults: Record<string, typeof results> = {};
      const ungroupedResults: typeof results = [];

      for (const r of successful) {
        const skillResults = bySkill.get(r.skill) || [];
        skillResults.push(r);
        bySkill.set(r.skill, skillResults);

        // We only need to group once per skill (take the first result for that skill)
        if (skillResults.length === 1) {
          if (r.pluginName) {
            const group = r.pluginName;
            if (!groupedResults[group]) groupedResults[group] = [];
            // We'll store just one entry per skill here to drive the loop
            groupedResults[group].push(r);
          } else {
            ungroupedResults.push(r);
          }
        }
      }

      const skillCount = bySkill.size;
      const symlinkFailures = successful.filter((r) => r.mode === 'symlink' && r.symlinkFailed);
      const copiedAgents = symlinkFailures.map((r) => r.agent);
      const resultLines: string[] = [];

      const printSkillResults = (entries: typeof results) => {
        for (const entry of entries) {
          const skillResults = bySkill.get(entry.skill) || [];
          const firstResult = skillResults[0]!;

          if (firstResult.mode === 'copy') {
            // Copy mode: show skill name and list all agent paths
            resultLines.push(`${pc.green('✓')} ${entry.skill} ${pc.dim('(copied)')}`);
            for (const r of skillResults) {
              const shortPath = shortenPath(r.path, cwd);
              resultLines.push(`  ${pc.dim('→')} ${shortPath}`);
            }
          } else {
            // Symlink mode: show canonical path and universal/symlinked agents
            if (firstResult.canonicalPath) {
              const shortPath = shortenPath(firstResult.canonicalPath, cwd);
              resultLines.push(`${pc.green('✓')} ${shortPath}`);
            } else {
              resultLines.push(`${pc.green('✓')} ${entry.skill}`);
            }
            resultLines.push(...buildResultLines(skillResults, targetAgents));
          }
        }
      };

      // Print grouped results
      const sortedResultGroups = Object.keys(groupedResults).sort();

      for (const group of sortedResultGroups) {
        const title = group
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');

        resultLines.push('');
        resultLines.push(pc.bold(title));
        printSkillResults(groupedResults[group]!);
      }

      if (ungroupedResults.length > 0) {
        if (sortedResultGroups.length > 0) {
          resultLines.push('');
          resultLines.push(pc.bold('General'));
        }
        printSkillResults(ungroupedResults);
      }

      const title = pc.green(`Installed ${skillCount} skill${skillCount !== 1 ? 's' : ''}`);
      p.note(resultLines.join('\n'), title);

      // Show symlink failure warning (only for symlink mode)
      if (symlinkFailures.length > 0) {
        p.log.warn(pc.yellow(`Symlinks failed for: ${formatList(copiedAgents)}`));
        p.log.message(
          pc.dim(
            '  Files were copied instead. On Windows, enable Developer Mode for symlink support.'
          )
        );
      }
    }

    const successfulMcps = mcpResults.filter((r) => r.success);
    const failedMcps = mcpResults.filter((r) => !r.success);

    if (successfulMcps.length > 0) {
      const byMcp = new Map<string, typeof mcpResults>();
      for (const result of successfulMcps) {
        const serverResults = byMcp.get(result.server) || [];
        serverResults.push(result);
        byMcp.set(result.server, serverResults);
      }

      const resultLines: string[] = [];
      for (const [serverName, serverResults] of byMcp) {
        resultLines.push(`${pc.green('✓')} ${serverName}`);
        for (const result of serverResults) {
          resultLines.push(
            `  ${pc.dim('→')} ${result.agent}: ${pc.dim(shortenPath(result.path, cwd))}`
          );
        }
      }

      const title = pc.green(`Installed ${byMcp.size} MCP server${byMcp.size !== 1 ? 's' : ''}`);
      p.note(resultLines.join('\n'), title);
    }

    if (failed.length > 0) {
      console.log();
      p.log.error(pc.red(`Failed to install ${failed.length}`));
      for (const r of failed) {
        p.log.message(`  ${pc.red('✗')} ${r.skill} → ${r.agent}: ${pc.dim(r.error)}`);
      }
    }

    if (failedMcps.length > 0) {
      console.log();
      p.log.error(pc.red(`Failed to install ${failedMcps.length} MCP configuration(s)`));
      for (const r of failedMcps) {
        p.log.message(`  ${pc.red('✗')} ${r.server} → ${r.agent}: ${pc.dim(r.error)}`);
      }
    }

    console.log();
    const reviewMessage =
      successfulMcps.length > 0
        ? '  Review skills and MCP servers before use; they run with full agent permissions.'
        : '  Review skills before use; they run with full agent permissions.';
    p.outro(pc.green('Done!') + pc.dim(reviewMessage));
  } catch (error) {
    if (error instanceof GitCloneError) {
      p.log.error(pc.red(error.isCanceled ? 'Clone canceled' : 'Failed to clone repository'));
      // Print each line of the error message separately for better formatting
      for (const line of error.message.split('\n')) {
        p.log.message(pc.dim(line));
      }
    } else {
      p.log.error(error instanceof Error ? error.message : 'Unknown error occurred');
    }
    showInstallTip();
    p.outro(pc.red('Installation failed'));
    process.exit(1);
  } finally {
    await cleanup(tempDir);
  }
}

// Cleanup helper
async function cleanup(tempDir: string | null) {
  if (tempDir) {
    try {
      await cleanupTempDir(tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Parse command line options from args array
export function parseAddOptions(args: string[]): { source: string[]; options: AddOptions } {
  const options: AddOptions = {};
  const source: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-g' || arg === '--global') {
      options.global = true;
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true;
    } else if (arg === '-l' || arg === '--list') {
      options.list = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--no-mcp') {
      options.noMcp = true;
    } else if (arg === '--mcp') {
      options.mcp = options.mcp || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.mcp.push(nextArg);
        i++;
        nextArg = args[i];
      }
      if (options.mcp.length === 0) {
        options.mcp.push('*');
      }
      i--; // Back up one since the loop will increment
    } else if (arg === '-a' || arg === '--agent') {
      options.agent = options.agent || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.agent.push(nextArg);
        i++;
        nextArg = args[i];
      }
      i--; // Back up one since the loop will increment
    } else if (arg === '-s' || arg === '--skill') {
      options.skill = options.skill || [];
      i++;
      let nextArg = args[i];
      while (i < args.length && nextArg && !nextArg.startsWith('-')) {
        options.skill.push(nextArg);
        i++;
        nextArg = args[i];
      }
      i--; // Back up one since the loop will increment
    } else if (arg === '--full-depth') {
      options.fullDepth = true;
    } else if (arg === '--copy') {
      options.copy = true;
    } else if (arg && !arg.startsWith('-')) {
      source.push(arg);
    }
  }

  return { source, options };
}
