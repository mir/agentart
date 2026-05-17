import * as p from '@clack/prompts';
import { join, relative, sep } from 'path';
import { cleanupTempDir } from '../repo/clone.ts';
import pc from '../ui/colors.ts';
import { agents } from '../core/agents.ts';
import { runInteractiveInstallFromSource, discoverRepo } from './discover.ts';
import { collectInstalledArtifacts, type InstalledArtifacts, type Scope } from './list.ts';
import { installSkillForAgent } from '../artifacts/skills.ts';
import { installMcpServerForAgent } from '../artifacts/mcp.ts';
import { showLogo } from '../ui/banner.ts';
import { readMcpLock } from '../artifacts/mcp.ts';
import { installHookBundle } from '../artifacts/hooks.ts';
import { readHookLock } from '../artifacts/hook-records.ts';
import { readPluginRegistry } from '../artifacts/plugins.ts';
import { readSkillLock, addSkillToLock } from '../artifacts/skills.ts';
import { readLocalLock, addSkillToLocalLock, computeSkillFolderHash } from '../artifacts/skills.ts';
import { removeTargets, type RemoveTarget } from './remove.ts';
import { installPluginForAgent } from '../artifacts/plugins.ts';
import { findOutdatedItems, recordUpdatedSha, type OutdatedItem } from '../freshness.ts';
import { getSkillDisplayName } from '../artifacts/skills.ts';
import { collectSavedSources, type SavedSource } from '../source-catalog.ts';
import { runInteractiveMcpAdd } from './mcp-add.ts';
import {
  promptManageMenu,
  type ManageMenuAction,
  type ManageMenuKind,
  type ManageMenuRow,
} from '../ui/manage-menu.ts';
import type { AgentType } from '../core/agents.ts';
import type { Skill } from '../core/artifacts.ts';

type ManageArtifactKind = 'skill' | 'mcp' | 'hook' | 'plugin' | 'marketplace-entry';

type ManageArtifact = {
  key: string;
  kind: ManageArtifactKind;
  name: string;
  scope: Scope;
  agents: AgentType[];
  detail?: string;
  canUpdate: boolean;
  removeTarget?: RemoveTarget;
};

type ManageState = {
  artifacts: ManageArtifact[];
  summaries: Map<string, number>;
  outdated: OutdatedItem[];
  savedSources: SavedSource[];
};

export type ManageOptions = {
  showLogo?: boolean;
};

const ARTIFACT_LABELS: Record<ManageArtifactKind, string> = {
  skill: 'Skills',
  mcp: 'MCPs',
  hook: 'Hooks',
  plugin: 'Plugins',
  'marketplace-entry': 'Marketplace entries',
};

const PROJECT_KINDS: ManageArtifactKind[] = ['skill', 'mcp', 'hook', 'plugin', 'marketplace-entry'];
const GLOBAL_KINDS: ManageArtifactKind[] = ['skill', 'mcp'];

type ManageView =
  | { type: 'main' }
  | { type: 'category'; scope: Scope; kind: ManageArtifactKind }
  | { type: 'item'; key: string; returnTo: { scope: Scope; kind: ManageArtifactKind } }
  | { type: 'install' };

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

function artifactKey(scope: Scope, kind: ManageArtifactKind, name: string): string {
  return `${scope}:${kind}:${name}`;
}

function groupAgents(existing: ManageArtifact | undefined, agent: AgentType): AgentType[] {
  return [...new Set([...(existing?.agents ?? []), agent])].sort();
}

function staleKeys(outdated: OutdatedItem[]): Set<string> {
  return new Set(
    outdated.map((item) =>
      artifactKey(item.scope as Scope, item.kind as ManageArtifactKind, item.name)
    )
  );
}

function pushGrouped(
  groups: Map<string, ManageArtifact>,
  artifact: Omit<ManageArtifact, 'key' | 'agents'> & { agents: AgentType[] }
): void {
  const key = artifactKey(artifact.scope, artifact.kind, artifact.name);
  const existing = groups.get(key);
  groups.set(key, {
    key,
    ...artifact,
    agents: existing
      ? [...new Set([...existing.agents, ...artifact.agents])].sort()
      : [...new Set(artifact.agents)].sort(),
  });
}

function buildManageArtifacts(
  installed: InstalledArtifacts,
  outdated: OutdatedItem[]
): ManageArtifact[] {
  const keys = staleKeys(outdated);
  const groups = new Map<string, ManageArtifact>();
  for (const skill of installed.skills) {
    pushGrouped(groups, {
      kind: 'skill',
      name: skill.name,
      scope: skill.scope,
      agents: skill.agents,
      canUpdate: keys.has(artifactKey(skill.scope, 'skill', skill.name)),
      removeTarget: { type: 'skill', name: skill.name, scope: skill.scope, agents: skill.agents },
    });
  }
  for (const server of installed.mcps) {
    const key = artifactKey(server.scope, 'mcp', server.name);
    const existing = groups.get(key);
    groups.set(key, {
      key,
      kind: 'mcp',
      name: server.name,
      scope: server.scope,
      agents: groupAgents(existing, server.agent),
      detail: server.transport === 'stdio' ? server.command : server.url,
      canUpdate: keys.has(key),
      removeTarget: {
        type: 'mcp',
        name: server.name,
        scope: server.scope,
        agents: groupAgents(existing, server.agent),
      },
    });
  }
  for (const hook of installed.hooks) {
    pushGrouped(groups, {
      kind: 'hook',
      name: hook.name,
      scope: 'project',
      agents: [hook.agent],
      detail: hook.events.join(', '),
      canUpdate: keys.has(artifactKey('project', 'hook', hook.name)),
      removeTarget: { type: 'hook', name: hook.name, scope: 'project', agents: [hook.agent] },
    });
  }
  for (const plugin of installed.plugins) {
    const key = artifactKey(plugin.scope, 'plugin', plugin.name);
    const existing = groups.get(key);
    groups.set(key, {
      key,
      kind: 'plugin',
      name: plugin.name,
      scope: plugin.scope,
      agents: groupAgents(existing, plugin.agent),
      detail: plugin.source,
      canUpdate: keys.has(key),
      removeTarget: {
        type: 'plugin',
        name: plugin.name,
        scope: plugin.scope,
        agents: groupAgents(existing, plugin.agent),
      },
    });
  }
  for (const entry of installed.marketplaceEntries) {
    const key = artifactKey(entry.scope, 'marketplace-entry', entry.name);
    const existing = groups.get(key);
    groups.set(key, {
      key,
      kind: 'marketplace-entry',
      name: entry.name,
      scope: entry.scope,
      agents: groupAgents(existing, entry.agent),
      detail: entry.source,
      canUpdate: false,
      removeTarget: {
        type: 'marketplace-entry',
        name: entry.name,
        scope: entry.scope,
        agents: groupAgents(existing, entry.agent),
      },
    });
  }
  return [...groups.values()].sort((a, b) =>
    `${a.scope}:${a.kind}:${a.name}`.localeCompare(`${b.scope}:${b.kind}:${b.name}`)
  );
}

function countArtifactsByScopeAndKind(artifacts: ManageArtifact[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    const key = artifactKey(artifact.scope, artifact.kind, '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

async function loadManageState(): Promise<ManageState> {
  const [installed, savedSources, outdated] = await Promise.all([
    collectInstalledArtifacts(),
    collectSavedSources(),
    findOutdatedItems().catch(() => []),
  ]);
  const artifacts = buildManageArtifacts(installed, outdated);
  return {
    artifacts,
    summaries: countArtifactsByScopeAndKind(artifacts),
    outdated,
    savedSources,
  };
}

function summaryCount(state: ManageState, scope: Scope, kind: ManageArtifactKind): number {
  return state.summaries.get(artifactKey(scope, kind, '')) ?? 0;
}

function buildMainRows(state: ManageState): ManageMenuRow[] {
  const rows: ManageMenuRow[] = [{ label: 'Project', value: { type: 'quit' }, selectable: false }];
  for (const kind of PROJECT_KINDS) {
    const count = summaryCount(state, 'project', kind);
    rows.push({
      label: ARTIFACT_LABELS[kind],
      value: { type: 'category', scope: 'project', kind: kind as ManageMenuKind },
      depth: 1,
      count,
      selectable: count > 0,
    });
  }
  rows.push({ label: 'Global', value: { type: 'quit' }, selectable: false });
  for (const kind of GLOBAL_KINDS) {
    const count = summaryCount(state, 'global', kind);
    rows.push({
      label: ARTIFACT_LABELS[kind],
      value: { type: 'category', scope: 'global', kind: kind as ManageMenuKind },
      depth: 1,
      count,
      selectable: count > 0,
    });
  }
  rows.push({ label: 'Install', value: { type: 'install' } });
  rows.push({ label: 'Add MCP endpoint', value: { type: 'add-mcp' } });
  rows.push({ label: 'Quit', value: { type: 'quit' } });
  return rows;
}

function artifactHint(artifact: ManageArtifact): string {
  return [
    formatAgentList(artifact.agents),
    artifact.detail,
    artifact.canUpdate ? 'update available' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

function buildCategoryRows(
  state: ManageState,
  scope: Scope,
  kind: ManageArtifactKind
): ManageMenuRow[] {
  const artifacts = state.artifacts.filter((item) => item.scope === scope && item.kind === kind);
  const rows: ManageMenuRow[] = artifacts.map((artifact) => ({
    label: artifact.name,
    value: { type: 'artifact' as const, key: artifact.key },
    hint: artifactHint(artifact),
  }));
  rows.push({ label: 'Back', value: { type: 'back' as const } });
  return rows;
}

function buildItemRows(artifact: ManageArtifact): ManageMenuRow[] {
  const rows: ManageMenuRow[] = [];
  if (artifact.canUpdate && artifact.kind !== 'marketplace-entry') {
    rows.push({ label: 'Update', value: { type: 'artifact-action', action: 'update' } });
  }
  if (artifact.removeTarget) {
    rows.push({ label: 'Remove', value: { type: 'artifact-action', action: 'remove' } });
  }
  rows.push({ label: 'Back', value: { type: 'back' } });
  return rows;
}

function duplicateSavedSourceNames(sources: SavedSource[]): Set<string> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const key = source.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function savedSourceHint(source: SavedSource, duplicateNames: Set<string>): string {
  return duplicateNames.has(source.name.toLowerCase())
    ? `${source.kind} · ${source.source}`
    : source.source;
}

function buildInstallRows(state: ManageState): ManageMenuRow[] {
  const rows: ManageMenuRow[] = [
    { label: 'Saved sources', value: { type: 'back' }, selectable: false },
  ];
  const duplicateNames = duplicateSavedSourceNames(state.savedSources);
  if (state.savedSources.length === 0) {
    rows.push({
      label: 'No saved sources yet.',
      value: { type: 'back' },
      depth: 1,
      selectable: false,
    });
  } else {
    state.savedSources.forEach((source, index) =>
      rows.push({
        label: source.name,
        value: { type: 'install-source', index },
        depth: 1,
        hint: savedSourceHint(source, duplicateNames),
      })
    );
  }
  rows.push({ label: 'Add git repo', value: { type: 'install-add-git-repo' } });
  rows.push({ label: 'Back', value: { type: 'back' } });
  return rows;
}

function viewTitle(view: ManageView, state: ManageState): string {
  if (view.type === 'install') return 'Install';
  if (view.type === 'category')
    return `${view.scope === 'project' ? 'Project' : 'Global'} / ${ARTIFACT_LABELS[view.kind]}`;
  if (view.type === 'item') {
    return state.artifacts.find((artifact) => artifact.key === view.key)?.name ?? 'Item';
  }
  return 'Manage';
}

function buildRowsForView(view: ManageView, state: ManageState): ManageMenuRow[] {
  if (view.type === 'install') return buildInstallRows(state);
  if (view.type === 'category') return buildCategoryRows(state, view.scope, view.kind);
  if (view.type === 'item') {
    const artifact = state.artifacts.find((item) => item.key === view.key);
    return artifact ? buildItemRows(artifact) : [{ label: 'Back', value: { type: 'back' } }];
  }
  return buildMainRows(state);
}

async function updateSkill(target: ManageArtifact): Promise<boolean> {
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
    for (const agent of target.agents.length > 0
      ? target.agents
      : (Object.keys(agents) as AgentType[])) {
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

async function updateMcp(target: ManageArtifact): Promise<boolean> {
  const global = target.scope === 'global';
  const lock = await readMcpLock({ global });
  const entry = lock.mcps[target.name];
  if (!entry) return false;
  const results = await Promise.all(
    target.agents.map((agent) => installMcpServerForAgent(entry.server, agent, { global }))
  );
  return results.some((result) => result.success);
}

async function updateHook(target: ManageArtifact): Promise<boolean> {
  const lock = await readHookLock();
  const entry = lock.hooks[target.name];
  if (!entry) return false;
  const discovered = await discoverRepo(entry.source);
  try {
    const hook = discovered.hooks.find(
      (candidate) => candidate.agent === entry.agent && candidate.configPath === entry.configPath
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

async function updatePlugin(target: ManageArtifact): Promise<boolean> {
  const global = target.scope === 'global';
  const lock = await readPluginRegistry({ global });
  const entry = lock.plugins[target.name];
  if (!entry) return false;
  const plugin = {
    name: entry.name,
    configPath: entry.rootPath,
    marketplaceName: entry.marketplaceName,
    marketplacePath: entry.marketplacePath,
    source: entry.locator,
  };
  const results = [];
  for (const agent of target.agents.length > 0 ? target.agents : entry.agents) {
    if (agent === 'codex' || agent === 'claude-code') {
      results.push(
        await installPluginForAgent(plugin, agent, target.scope, 'INSTALLED_BY_DEFAULT')
      );
    }
  }
  return results.some((result) => result.success);
}

async function updateArtifact(item: ManageArtifact): Promise<boolean> {
  if (item.kind === 'skill') return updateSkill(item);
  if (item.kind === 'mcp') return updateMcp(item);
  if (item.kind === 'hook') return updateHook(item);
  if (item.kind === 'plugin') return updatePlugin(item);
  return false;
}

async function updateArtifacts(
  artifacts: ManageArtifact[],
  outdated: OutdatedItem[]
): Promise<number> {
  const outdatedByKey = new Map(
    outdated.map((item) => [
      artifactKey(item.scope as Scope, item.kind as ManageArtifactKind, item.name),
      item,
    ])
  );
  let updated = 0;
  for (const artifact of artifacts) {
    const stale = outdatedByKey.get(artifactKey(artifact.scope, artifact.kind, artifact.name));
    if (!stale || !(await updateArtifact(artifact))) continue;
    updated++;
    await recordUpdatedSha(stale).catch(() => undefined);
  }
  if (updated === 0) {
    p.log.warn('No selected items could be updated.');
  } else {
    p.log.success(`Updated ${updated} item(s).`);
  }
  return updated;
}

async function addGitRepo(): Promise<void> {
  const value = await p.text({ message: 'Git repo:' });
  if (isCancel(value)) {
    p.log.warn('Cancelled.');
    return;
  }
  if (!value || typeof value !== 'string') return;
  await installFromSource(value, 'sloprider install from git repo');
}

async function installFromSource(
  source: string,
  title: string,
  options?: Parameters<typeof runInteractiveInstallFromSource>[2]
): Promise<void> {
  try {
    if (options === undefined) {
      await runInteractiveInstallFromSource(source, title);
    } else {
      await runInteractiveInstallFromSource(source, title, options);
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
  }
}

async function handleAction(
  action: ManageMenuAction,
  state: ManageState,
  views: ManageView[]
): Promise<{ reload: boolean; quit: boolean }> {
  const currentView = views.at(-1) ?? { type: 'main' as const };
  if (action.type === 'quit') return { reload: false, quit: true };
  if (action.type === 'back') {
    if (views.length > 1) views.pop();
    return { reload: false, quit: false };
  }
  if (action.type === 'category') {
    views.push({ type: 'category', scope: action.scope, kind: action.kind as ManageArtifactKind });
    return { reload: false, quit: false };
  }
  if (action.type === 'artifact') {
    const artifact = state.artifacts.find((item) => item.key === action.key);
    if (artifact && currentView.type === 'category') {
      views.push({
        type: 'item',
        key: artifact.key,
        returnTo: { scope: currentView.scope, kind: currentView.kind },
      });
    }
    return { reload: false, quit: false };
  }
  if (action.type === 'artifact-action') {
    if (currentView.type !== 'item') return { reload: false, quit: false };
    const artifact = state.artifacts.find((item) => item.key === currentView.key);
    if (!artifact) {
      views.pop();
      return { reload: false, quit: false };
    }
    if (action.action === 'remove') {
      if (artifact.removeTarget) await removeTargets([artifact.removeTarget]);
    } else {
      await updateArtifacts([artifact], state.outdated);
    }
    views.pop();
    return { reload: true, quit: false };
  }
  if (action.type === 'install') {
    views.push({ type: 'install' });
    return { reload: false, quit: false };
  }
  if (action.type === 'install-source') {
    const source = state.savedSources[action.index];
    if (source) await installFromSource(source.source, 'sloprider install from saved source');
    views.splice(1);
    return { reload: true, quit: false };
  }
  if (action.type === 'install-add-git-repo') {
    await addGitRepo();
    views.splice(1);
    return { reload: true, quit: false };
  }
  await runInteractiveMcpAdd();
  views.splice(1);
  return { reload: true, quit: false };
}

export async function runManage(options: ManageOptions = {}): Promise<void> {
  if (options.showLogo ?? true) showLogo();
  p.intro(pc.bgCyan(pc.black(' sloprider manage ')));
  const views: ManageView[] = [{ type: 'main' }];
  let state = await loadManageState();
  while (true) {
    const currentView = views.at(-1) ?? { type: 'main' as const };
    const action = await promptManageMenu(buildRowsForView(currentView, state), {
      title: viewTitle(currentView, state),
    });
    if (isCancel(action)) {
      if (views.length > 1) {
        views.pop();
        continue;
      }
      p.cancel('Cancelled');
      return;
    }
    const result = await handleAction(action, state, views);
    if (result.quit) {
      p.outro(pc.green('Done!'));
      return;
    }
    if (result.reload) {
      state = await loadManageState();
      const view = views.at(-1);
      if (view?.type === 'category') {
        const hasItems = state.artifacts.some(
          (artifact) => artifact.scope === view.scope && artifact.kind === view.kind
        );
        if (!hasItems) views.pop();
      }
    }
  }
}
