import { readPluginLock, writePluginLock, type PluginLockEntry } from './plugin-lock.ts';
import { readMcpLock, writeMcpLock, type McpLockEntry } from './mcp-lock.ts';
import { readHookLock, writeHookLock, type HookLockEntry } from './hook-lock.ts';
import { readSkillLock, writeSkillLock, type SkillLockEntry } from './skill-lock.ts';
import { readLocalLock, writeLocalLock, type LocalSkillLockEntry } from './local-lock.ts';
import { lsRemoteSha } from './git-sha.ts';
import type { Scope } from './discover.ts';
import type { AgentType } from './types.ts';

export type FreshnessKind = 'plugin' | 'mcp' | 'hook' | 'skill';

export interface OutdatedItem {
  kind: FreshnessKind;
  name: string;
  scope: Scope | 'project';
  sourceUrl: string;
  ref?: string;
  installedSha: string;
  remoteSha: string;
  agents?: AgentType[];
}

interface Candidate {
  kind: FreshnessKind;
  name: string;
  scope: Scope | 'project';
  sourceUrl: string;
  ref?: string;
  installedSha: string;
  agents?: AgentType[];
}

function pluginUrl(entry: PluginLockEntry): string | undefined {
  if (entry.sourceUrl) return entry.sourceUrl;
  if (entry.pluginSource.source === 'git-subdir') return entry.pluginSource.url;
  return undefined;
}

function mcpUrl(entry: McpLockEntry): string | undefined {
  if (entry.sourceUrl) return entry.sourceUrl;
  if (
    entry.sourceType === 'github' ||
    entry.sourceType === 'gitlab' ||
    entry.sourceType === 'git'
  ) {
    return entry.source;
  }
  return undefined;
}

function skillUrl(entry: SkillLockEntry): string | undefined {
  return (
    entry.sourceUrl || (entry.source && entry.source.includes('://') ? entry.source : undefined)
  );
}

function localSkillUrl(entry: LocalSkillLockEntry): string | undefined {
  if (!entry.source) return undefined;
  if (
    entry.sourceType === 'github' ||
    entry.sourceType === 'gitlab' ||
    entry.sourceType === 'git'
  ) {
    return entry.source;
  }
  return undefined;
}

async function collectCandidates(): Promise<Candidate[]> {
  const [projPlugins, globPlugins, projMcps, globMcps, hooks, globalSkills, localSkills] =
    await Promise.all([
      readPluginLock({ global: false }),
      readPluginLock({ global: true }),
      readMcpLock({ global: false }),
      readMcpLock({ global: true }),
      readHookLock(),
      readSkillLock(),
      readLocalLock(),
    ]);

  const out: Candidate[] = [];

  for (const [name, entry] of Object.entries(projPlugins.plugins)) {
    const url = pluginUrl(entry);
    if (!entry.sourceSha || !url) continue;
    out.push({
      kind: 'plugin',
      name,
      scope: 'project',
      sourceUrl: url,
      ref: entry.ref,
      installedSha: entry.sourceSha,
      agents: entry.agents,
    });
  }
  for (const [name, entry] of Object.entries(globPlugins.plugins)) {
    const url = pluginUrl(entry);
    if (!entry.sourceSha || !url) continue;
    out.push({
      kind: 'plugin',
      name,
      scope: 'global',
      sourceUrl: url,
      ref: entry.ref,
      installedSha: entry.sourceSha,
      agents: entry.agents,
    });
  }

  for (const [name, entry] of Object.entries(projMcps.mcps)) {
    const url = mcpUrl(entry);
    if (!entry.sourceSha || !url) continue;
    out.push({
      kind: 'mcp',
      name,
      scope: 'project',
      sourceUrl: url,
      ref: entry.ref,
      installedSha: entry.sourceSha,
    });
  }
  for (const [name, entry] of Object.entries(globMcps.mcps)) {
    const url = mcpUrl(entry);
    if (!entry.sourceSha || !url) continue;
    out.push({
      kind: 'mcp',
      name,
      scope: 'global',
      sourceUrl: url,
      ref: entry.ref,
      installedSha: entry.sourceSha,
    });
  }

  for (const [name, entry] of Object.entries(hooks.hooks)) {
    if (!entry.sourceSha) continue;
    out.push({
      kind: 'hook',
      name,
      scope: 'project',
      sourceUrl: entry.source,
      ref: entry.ref,
      installedSha: entry.sourceSha,
      agents: [entry.agent],
    });
  }

  for (const [name, entry] of Object.entries(globalSkills.skills)) {
    const url = skillUrl(entry);
    if (!entry.sourceSha || !url) continue;
    out.push({
      kind: 'skill',
      name,
      scope: 'global',
      sourceUrl: url,
      ref: entry.ref,
      installedSha: entry.sourceSha,
    });
  }

  for (const [name, entry] of Object.entries(localSkills.skills)) {
    const url = localSkillUrl(entry);
    if (!entry.sourceSha || !url) continue;
    out.push({
      kind: 'skill',
      name,
      scope: 'project',
      sourceUrl: url,
      ref: entry.ref,
      installedSha: entry.sourceSha,
    });
  }

  return out;
}

export async function findOutdatedItems(): Promise<OutdatedItem[]> {
  const candidates = await collectCandidates();
  if (candidates.length === 0) return [];

  const cache = new Map<string, Promise<string | null>>();
  const lookup = (url: string, ref?: string): Promise<string | null> => {
    const key = `${url}#${ref ?? ''}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = lsRemoteSha(url, ref);
      cache.set(key, entry);
    }
    return entry;
  };

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const remote = await lookup(candidate.sourceUrl, candidate.ref);
      if (!remote) return null;
      if (remote === candidate.installedSha) return null;
      return {
        kind: candidate.kind,
        name: candidate.name,
        scope: candidate.scope,
        sourceUrl: candidate.sourceUrl,
        ref: candidate.ref,
        installedSha: candidate.installedSha,
        remoteSha: remote,
        agents: candidate.agents,
      } satisfies OutdatedItem;
    })
  );

  return results.filter((item): item is NonNullable<typeof item> => item !== null);
}

export async function recordUpdatedSha(item: OutdatedItem): Promise<void> {
  if (item.kind === 'plugin') {
    const global = item.scope === 'global';
    const lock = await readPluginLock({ global });
    const entry = lock.plugins[item.name];
    if (!entry) return;
    lock.plugins[item.name] = {
      ...entry,
      sourceSha: item.remoteSha,
      updatedAt: new Date().toISOString(),
    };
    await writePluginLock(lock, { global });
    return;
  }
  if (item.kind === 'mcp') {
    const global = item.scope === 'global';
    const lock = await readMcpLock({ global });
    const entry = lock.mcps[item.name];
    if (!entry) return;
    lock.mcps[item.name] = {
      ...entry,
      sourceSha: item.remoteSha,
      updatedAt: new Date().toISOString(),
    };
    await writeMcpLock(lock, { global });
    return;
  }
  if (item.kind === 'hook') {
    const lock = await readHookLock();
    const entry = lock.hooks[item.name];
    if (!entry) return;
    lock.hooks[item.name] = {
      ...entry,
      sourceSha: item.remoteSha,
      updatedAt: new Date().toISOString(),
    };
    await writeHookLock(lock);
    return;
  }
  if (item.scope === 'global') {
    const lock = await readSkillLock();
    const entry = lock.skills[item.name];
    if (!entry) return;
    lock.skills[item.name] = {
      ...entry,
      sourceSha: item.remoteSha,
      updatedAt: new Date().toISOString(),
    };
    await writeSkillLock(lock);
    return;
  }
  const lock = await readLocalLock();
  const entry = lock.skills[item.name];
  if (!entry) return;
  lock.skills[item.name] = { ...entry, sourceSha: item.remoteSha };
  await writeLocalLock(lock);
}
