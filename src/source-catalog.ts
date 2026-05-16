import { getOwnerRepo, parseSource } from './core/source.ts';
import { readLocalLock } from './artifacts/skills.ts';
import { readSkillLock } from './artifacts/skills.ts';
import { readMcpLock } from './artifacts/mcp.ts';
import { readHookLock } from './artifacts/hook-records.ts';
import { listCodexMarketplacePlugins } from './artifacts/plugins.ts';
import { readPluginRegistry } from './artifacts/plugins.ts';
import type { PluginLocator } from './core/artifacts.ts';
export type SavedSourceKind = 'project marketplace' | 'global marketplace' | 'previous install';
export interface SavedSource {
  kind: SavedSourceKind;
  source: string;
  label: string;
}
const KIND_ORDER: Record<SavedSourceKind, number> = {
  'project marketplace': 0,
  'global marketplace': 1,
  'previous install': 2,
};
function sourceWithRef(url: string, ref?: string): string {
  const trimmed = url.trim();
  if (!ref) return trimmed;
  return `${trimmed}#${encodeURIComponent(ref)}`;
}
function gitSourceFromParts(
  source: string | undefined,
  sourceType: string | undefined,
  ref?: string,
  sourceUrl?: string
): string | null {
  if (!sourceType || sourceType === 'direct' || sourceType === 'local') return null;
  if (sourceType !== 'github' && sourceType !== 'gitlab' && sourceType !== 'git') return null;
  const candidate = (sourceUrl || source || '').trim();
  if (!candidate) return null;
  try {
    const parsed = parseSource(sourceWithRef(candidate, ref));
    if (parsed.type === 'local') return null;
    return sourceWithRef(candidate, ref);
  } catch {
    return null;
  }
}
function marketplaceSource(source: PluginLocator): string | null {
  if (source.source !== 'git-subdir') return null;
  return gitSourceFromParts(source.url, 'git', source.ref);
}
function displayName(source: string): string {
  try {
    const parsed = parseSource(source);
    return getOwnerRepo(parsed) ?? source;
  } catch {
    return source;
  }
}
function pushSource(
  sources: SavedSource[],
  seen: Set<string>,
  kind: SavedSourceKind,
  source: string
): void {
  const trimmed = source.trim();
  if (!trimmed) return;
  let key = trimmed;
  try {
    const parsed = parseSource(trimmed);
    key = sourceWithRef(parsed.url, parsed.ref);
  } catch {
    key = trimmed;
  }
  if (seen.has(key)) return;
  seen.add(key);
  sources.push({
    kind,
    source: trimmed,
    label: `${kind}: ${displayName(trimmed)}`,
  });
}
export async function collectSavedSources(): Promise<SavedSource[]> {
  const sources: SavedSource[] = [];
  const seen = new Set<string>();
  const [projectMarketplace, globalMarketplace] = await Promise.all([
    listCodexMarketplacePlugins('project'),
    listCodexMarketplacePlugins('global'),
  ]);
  for (const entry of projectMarketplace) {
    const source = marketplaceSource(entry.source);
    if (source) pushSource(sources, seen, 'project marketplace', source);
  }
  for (const entry of globalMarketplace) {
    const source = marketplaceSource(entry.source);
    if (source) pushSource(sources, seen, 'global marketplace', source);
  }
  const [localSkills, globalSkills, localMcps, globalMcps, hooks, localPlugins, globalPlugins] =
    await Promise.all([
      readLocalLock(),
      readSkillLock(),
      readMcpLock({ global: false }),
      readMcpLock({ global: true }),
      readHookLock(),
      readPluginRegistry({ global: false }),
      readPluginRegistry({ global: true }),
    ]);
  for (const entry of Object.values(localSkills.skills)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  for (const entry of Object.values(globalSkills.skills)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref, entry.sourceUrl);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  for (const entry of Object.values(localMcps.mcps)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref, entry.sourceUrl);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  for (const entry of Object.values(globalMcps.mcps)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref, entry.sourceUrl);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  for (const entry of Object.values(hooks.hooks)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  for (const entry of Object.values(localPlugins.plugins)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref, entry.sourceUrl);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  for (const entry of Object.values(globalPlugins.plugins)) {
    const source = gitSourceFromParts(entry.source, entry.sourceType, entry.ref, entry.sourceUrl);
    if (source) pushSource(sources, seen, 'previous install', source);
  }
  return sources.sort((a, b) => {
    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return kindDiff || a.label.localeCompare(b.label);
  });
}
