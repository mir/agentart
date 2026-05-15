import * as p from '@clack/prompts';
import { join, relative, sep } from 'path';
import { cleanupTempDir } from './git.ts';
import pc from './colors.ts';
import { agents } from './agents.ts';
import { runInteractiveDiscover, discoverRepo } from './discover.ts';
import { collectInstalledArtifacts, type Scope } from './list.ts';
import { runList } from './list.ts';
import { installSkillForAgent } from './installer.ts';
import { installMcpServerForAgent } from './mcp-config.ts';
import { runInteractiveMcpAdd } from './mcp-add.ts';
import { showLogo } from './banner.ts';
import { readMcpLock, type McpLockFile } from './mcp-lock.ts';
import { installHookBundle } from './hooks.ts';
import { readHookLock, type HookLockFile } from './hook-lock.ts';
import { readPluginLock, type PluginLockFile } from './plugin-lock.ts';
import { readSkillLock, addSkillToLock, type SkillLockFile } from './skill-lock.ts';
import {
  readLocalLock,
  addSkillToLocalLock,
  computeSkillFolderHash,
  type LocalSkillLockFile,
} from './local-lock.ts';
import { removeTargets, type RemoveTarget } from './remove.ts';
import { installPluginForAgent } from './plugin-agents.ts';
import { findOutdatedItems, recordUpdatedSha, type OutdatedItem } from './freshness.ts';
import { getSkillDisplayName } from './skills.ts';
import type { AgentType, Skill } from './types.ts';

export type ManageTarget = RemoveTarget & { label: string };
export type ManageOptions = {
  showLogo?: boolean;
};

function isCancel(value: unknown): value is symbol {
  return typeof value === 'symbol';
}

function relSkillPath(repoDir: string, skill: Skill): string {
  return relative(repoDir, join(skill.path, 'SKILL.md')).split(sep).join('/');
}

function formatAgentList(agentTypes: AgentType[]): string {
  if (agentTypes.length === 0) return 'Shared';
  return agentTypes
    .map((agent) => agents[agent]?.displayName ?? agent)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

function targetLabel(
  scope: Scope | 'project',
  type: 'skill' | 'mcp' | 'hook' | 'plugin',
  name: string,
  agentTypes: AgentType[]
): string {
  return `${scope} ${type}: ${name} (${formatAgentList(agentTypes)})`;
}

async function installedTargets(): Promise<ManageTarget[]> {
  const artifacts = await collectInstalledArtifacts();
  const skills: ManageTarget[] = artifacts.skills.map((skill) => ({
    type: 'skill',
    name: skill.name,
    scope: skill.scope,
    agents: skill.agents,
    label: targetLabel(skill.scope, 'skill', skill.name, skill.agents),
  }));

  const mcpGroups = new Map<string, ManageTarget>();
  for (const server of artifacts.mcps) {
    const key = `${server.scope}:${server.name}`;
    const existing = mcpGroups.get(key);
    if (existing) {
      existing.agents = [...(existing.agents ?? []), server.agent];
      existing.label = targetLabel(server.scope, 'mcp', server.name, existing.agents);
    } else {
      mcpGroups.set(key, {
        type: 'mcp',
        name: server.name,
        scope: server.scope,
        agents: [server.agent],
        label: targetLabel(server.scope, 'mcp', server.name, [server.agent]),
      });
    }
  }

  const hooks: ManageTarget[] = artifacts.hooks.map((hook) => ({
    type: 'hook',
    name: hook.name,
    scope: 'project',
    agents: [hook.agent],
    label: targetLabel('project', 'hook', hook.name, [hook.agent]),
  }));
  const pluginGroups = new Map<string, ManageTarget>();
  for (const plugin of artifacts.plugins) {
    const key = `${plugin.scope}:${plugin.name}`;
    const existing = pluginGroups.get(key);
    if (existing) {
      existing.agents = [...(existing.agents ?? []), plugin.agent];
      existing.label = targetLabel(plugin.scope, 'plugin', plugin.name, existing.agents);
    } else {
      pluginGroups.set(key, {
        type: 'plugin',
        name: plugin.name,
        scope: plugin.scope,
        agents: [plugin.agent],
        label: targetLabel(plugin.scope, 'plugin', plugin.name, [plugin.agent]),
      });
    }
  }

  return [...skills, ...mcpGroups.values(), ...hooks, ...pluginGroups.values()].sort((a, b) =>
    a.label.localeCompare(b.label)
  );
}

type InstalledLocks = {
  globalSkills: SkillLockFile;
  localSkills: LocalSkillLockFile;
  globalMcps: McpLockFile;
  localMcps: McpLockFile;
  hooks: HookLockFile;
  globalPlugins: PluginLockFile;
  localPlugins: PluginLockFile;
};

function isGitBackedSourceType(sourceType: string): boolean {
  return sourceType === 'github' || sourceType === 'gitlab' || sourceType === 'git';
}

function canUpdateSkill(
  target: Extract<ManageTarget, { type: 'skill' }>,
  locks: InstalledLocks
): boolean {
  const global = target.scope === 'global';
  const lock = global ? locks.globalSkills : locks.localSkills;
  const entry = lock.skills[target.name];
  if (!entry || !isGitBackedSourceType(entry.sourceType)) return false;

  const source = global && 'sourceUrl' in entry ? entry.sourceUrl || entry.source : entry.source;
  return typeof source === 'string' && source.trim().length > 0;
}

function canUpdateMcp(
  target: Extract<ManageTarget, { type: 'mcp' }>,
  locks: InstalledLocks
): boolean {
  const lock = target.scope === 'global' ? locks.globalMcps : locks.localMcps;
  return Boolean(lock.mcps[target.name]);
}

function canUpdateHook(
  target: Extract<ManageTarget, { type: 'hook' }>,
  locks: InstalledLocks
): boolean {
  return Boolean(locks.hooks.hooks[target.name]);
}

function canUpdatePlugin(
  target: Extract<ManageTarget, { type: 'plugin' }>,
  locks: InstalledLocks
): boolean {
  const lock = target.scope === 'global' ? locks.globalPlugins : locks.localPlugins;
  return Boolean(lock.plugins[target.name]);
}

export async function updatableInstalledTargets(): Promise<ManageTarget[]> {
  const targets = await installedTargets();
  const [globalSkills, localSkills, globalMcps, localMcps, hooks, globalPlugins, localPlugins] =
    await Promise.all([
      readSkillLock(),
      readLocalLock(),
      readMcpLock({ global: true }),
      readMcpLock({ global: false }),
      readHookLock(),
      readPluginLock({ global: true }),
      readPluginLock({ global: false }),
    ]);
  const locks = {
    globalSkills,
    localSkills,
    globalMcps,
    localMcps,
    hooks,
    globalPlugins,
    localPlugins,
  };

  return targets.filter((target) => {
    if (target.type === 'skill') return canUpdateSkill(target, locks);
    if (target.type === 'mcp') return canUpdateMcp(target, locks);
    if (target.type === 'hook') return canUpdateHook(target, locks);
    return canUpdatePlugin(target, locks);
  });
}

async function selectTargets(updateOnly = false): Promise<ManageTarget[] | null> {
  const targets = updateOnly ? await updatableInstalledTargets() : await installedTargets();
  if (targets.length === 0) {
    p.log.warn(
      updateOnly
        ? 'No updatable installed skills, MCP servers, or hooks found.'
        : 'No installed skills, MCP servers, or hooks found.'
    );
    return [];
  }

  const selected = await p.multiselect<ManageTarget>({
    message: `Select ${updateOnly ? 'updatable ' : ''}installed items ${pc.dim('(space to toggle)')}`,
    options: targets.map((target) => ({
      value: target,
      label: target.label,
    })) as p.Option<ManageTarget>[],
    required: true,
  });

  if (isCancel(selected)) {
    p.log.warn('Cancelled.');
    return null;
  }

  return selected as ManageTarget[];
}

async function updateSkill(target: Extract<ManageTarget, { type: 'skill' }>): Promise<boolean> {
  const global = target.scope === 'global';
  const lock = global ? await readSkillLock() : await readLocalLock();
  const entry = lock.skills[target.name];
  if (!entry) return false;

  const source = global && 'sourceUrl' in entry ? entry.sourceUrl || entry.source : entry.source;
  const discovered = await discoverRepo(source);
  try {
    const skill = discovered.skills.find((candidate) => {
      const candidatePath = relSkillPath(discovered.repoDir, candidate);
      return candidatePath === entry.skillPath || getSkillDisplayName(candidate) === target.name;
    });
    if (!skill) return false;

    for (const agent of target.agents ?? (Object.keys(agents) as AgentType[])) {
      await installSkillForAgent(skill, agent, { global });
    }

    const hash = await computeSkillFolderHash(skill.path);
    if (global) {
      await addSkillToLock(target.name, {
        source: entry.source,
        sourceType: entry.sourceType,
        sourceUrl: 'sourceUrl' in entry ? entry.sourceUrl : source,
        ref: entry.ref,
        skillPath: entry.skillPath,
        skillFolderHash: hash,
        pluginName: 'pluginName' in entry ? entry.pluginName : undefined,
      });
    } else {
      await addSkillToLocalLock(target.name, { ...entry, computedHash: hash });
    }
    return true;
  } finally {
    await cleanupTempDir(discovered.repoDir).catch(() => {});
  }
}

async function updateMcp(target: Extract<ManageTarget, { type: 'mcp' }>): Promise<boolean> {
  const global = target.scope === 'global';
  const lock = await readMcpLock({ global });
  const entry = lock.mcps[target.name];
  if (!entry) return false;

  const results = await Promise.all(
    (target.agents ?? []).map((agent) => installMcpServerForAgent(entry.server, agent, { global }))
  );
  return results.some((result) => result.success);
}

async function updateHook(target: Extract<ManageTarget, { type: 'hook' }>): Promise<boolean> {
  const lock = await readHookLock();
  const entry = lock.hooks[target.name];
  if (!entry) return false;

  const discovered = await discoverRepo(entry.source);
  try {
    const hook = discovered.hooks.find(
      (candidate) => candidate.agent === entry.agent && candidate.sourcePath === entry.sourcePath
    );
    if (!hook) return false;

    const base = discovered.parsed.subpath
      ? join(discovered.repoDir, discovered.parsed.subpath)
      : discovered.repoDir;
    const result = await installHookBundle(base, hook, discovered.parsed, entry.source);
    return result.success;
  } finally {
    await cleanupTempDir(discovered.repoDir).catch(() => {});
  }
}

async function updatePlugin(target: Extract<ManageTarget, { type: 'plugin' }>): Promise<boolean> {
  const global = target.scope === 'global';
  const lock = await readPluginLock({ global });
  const entry = lock.plugins[target.name];
  if (!entry) return false;

  const plugin = {
    name: entry.name,
    sourcePath: entry.pluginPath,
    marketplaceName: entry.marketplaceName,
    marketplacePath: entry.marketplacePath,
    source: entry.pluginSource,
  };
  const results = [];
  for (const agent of target.agents ?? entry.agents) {
    if (agent === 'codex' || agent === 'claude-code') {
      results.push(
        await installPluginForAgent(
          plugin,
          agent,
          target.scope ?? 'project',
          'INSTALLED_BY_DEFAULT'
        )
      );
    }
  }
  return results.some((result) => result.success);
}

async function updateTargets(targets: ManageTarget[]): Promise<void> {
  let updated = 0;
  for (const target of targets) {
    const ok =
      target.type === 'skill'
        ? await updateSkill(target)
        : target.type === 'mcp'
          ? await updateMcp(target)
          : target.type === 'hook'
            ? await updateHook(target)
            : await updatePlugin(target);
    if (ok) updated++;
  }
  if (updated === 0) {
    p.log.warn('No selected items could be updated.');
  } else {
    p.log.success(`Updated ${updated} item(s).`);
  }
}

async function addFromUrl(): Promise<void> {
  const value = await p.text({ message: 'Git URL to discover' });
  if (isCancel(value)) {
    p.log.warn('Cancelled.');
    return;
  }
  if (!value || typeof value !== 'string') return;
  await runInteractiveDiscover([value]);
}

function outdatedToTargets(items: OutdatedItem[]): ManageTarget[] {
  return items.map((item) => ({
    type: item.kind,
    name: item.name,
    scope: item.scope as Scope,
    agents: item.agents,
    label: `${item.scope} ${item.kind}: ${item.name} (${formatAgentList(item.agents ?? [])})`,
  })) as ManageTarget[];
}

async function checkAndPromptFreshness(): Promise<void> {
  let spinner: ReturnType<typeof p.spinner> | undefined;
  try {
    spinner = p.spinner();
    spinner.start('Checking for updates...');
  } catch {
    spinner = undefined;
  }
  let outdated: OutdatedItem[];
  try {
    outdated = await findOutdatedItems();
  } catch {
    spinner?.stop('Update check failed', 1);
    return;
  }
  if (outdated.length === 0) {
    spinner?.stop('All installed items are up to date');
    return;
  }
  spinner?.stop(`${outdated.length} item(s) have updates available`);

  for (const item of outdated) {
    p.log.message(
      `  ${pc.yellow('•')} ${item.scope} ${item.kind}: ${item.name} ${pc.dim(
        `(${item.installedSha.slice(0, 7)} → ${item.remoteSha.slice(0, 7)})`
      )}`
    );
  }

  const confirmed = await p.confirm({ message: 'Update outdated items now?' });
  if (isCancel(confirmed) || !confirmed) return;
  await updateTargets(outdatedToTargets(outdated));
  await Promise.all(outdated.map((item) => recordUpdatedSha(item).catch(() => undefined)));
}

export async function runManage(options: ManageOptions = {}): Promise<void> {
  if (options.showLogo ?? true) showLogo();
  p.intro(pc.bgCyan(pc.black(' sloprider manage ')));

  await checkAndPromptFreshness();

  while (true) {
    const action = await p.select({
      message: 'What do you want to do?',
      options: [
        { value: 'list-installed', label: 'List installed' },
        { value: 'remove-selected', label: 'Remove selected' },
        { value: 'update-selected', label: 'Update selected' },
        { value: 'update-all', label: 'Update all' },
        { value: 'discover', label: 'Discover from git URL' },
        { value: 'add-remote-mcp', label: 'Add remote MCP server' },
        { value: 'quit', label: 'Quit' },
      ],
    });

    if (isCancel(action)) {
      p.cancel('Cancelled');
      return;
    }

    if (action === 'quit') {
      p.outro(pc.green('Done!'));
      return;
    }

    if (action === 'discover') {
      await addFromUrl();
      continue;
    }

    if (action === 'add-remote-mcp') {
      await runInteractiveMcpAdd();
      continue;
    }

    if (action === 'list-installed') {
      await runList([]);
      continue;
    }

    const targets =
      action === 'update-all'
        ? await updatableInstalledTargets()
        : await selectTargets(action === 'update-selected');
    if (targets === null) continue;
    if (targets.length === 0) {
      if (action === 'update-all') {
        p.log.warn('No updatable installed skills, MCP servers, or hooks found.');
      }
      continue;
    }

    if (action === 'remove-selected') {
      await removeTargets(targets);
    } else {
      await updateTargets(targets);
    }
  }
}
