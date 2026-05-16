import { readFile, stat } from 'fs/promises';
import { join, basename, dirname, resolve, normalize, sep, relative } from 'path';
import { isRecord, parseFrontmatter } from '../util/frontmatter.ts';
import { sanitizeMetadata } from '../util/sanitize.ts';
import type { Skill } from '../core/artifacts.ts';
import { getPluginSkillPaths, getPluginGroupings } from './plugins.ts';
import { priorityRankForPath, scanRepoForFilenames } from '../repo/scan.ts';
export const SKILL_PRIORITY_DIRS = [
  '',
  'skills',
  'skills/.curated',
  'skills/.experimental',
  'skills/.system',
  '.agents/skills',
  '.claude/skills',
  '.codex/skills',
  '.github/skills',
  '.opencode/skills',
  '.pi/skills',
];
export function shouldInstallInternalSkills(): boolean {
  const envValue = process.env.INSTALL_INTERNAL_SKILLS;
  return envValue === '1' || envValue === 'true';
}
async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    const skillPath = join(dir, 'SKILL.md');
    const stats = await stat(skillPath);
    return stats.isFile();
  } catch {
    return false;
  }
}
export async function parseSkillMd(
  skillMdPath: string,
  options?: { includeInternal?: boolean }
): Promise<Skill | null> {
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    const { data } = parseFrontmatter(content);
    if (!data.description) {
      return null;
    }
    if (
      (data.name !== undefined && (typeof data.name !== 'string' || data.name.length === 0)) ||
      typeof data.description !== 'string'
    ) {
      return null;
    }
    const metadata = isRecord(data.metadata) ? data.metadata : undefined;
    const isInternal = metadata?.internal === true;
    if (isInternal && !shouldInstallInternalSkills() && !options?.includeInternal) {
      return null;
    }
    return {
      name: sanitizeMetadata(data.name ?? basename(dirname(skillMdPath))),
      description: sanitizeMetadata(data.description),
      path: dirname(skillMdPath),
      rawContent: content,
      metadata,
    };
  } catch {
    return null;
  }
}
export interface DiscoverSkillsOptions {
  includeInternal?: boolean;
  fullDepth?: boolean;
}
export function isSubpathSafe(basePath: string, subpath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(join(basePath, subpath)));
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}
export async function discoverSkills(
  basePath: string,
  subpath?: string,
  options?: DiscoverSkillsOptions
): Promise<Skill[]> {
  if (subpath && !isSubpathSafe(basePath, subpath)) {
    throw new Error(
      `Invalid subpath: "${subpath}" resolves outside the repository directory. Subpath must not contain ".." segments that escape the base path.`
    );
  }
  const searchPath = subpath ? join(basePath, subpath) : basePath;
  const pluginGroupings = await getPluginGroupings(searchPath);
  const enhanceSkill = (skill: Skill) => {
    const resolvedPath = resolve(skill.path);
    if (pluginGroupings.has(resolvedPath)) {
      skill.pluginName = pluginGroupings.get(resolvedPath);
    }
    return skill;
  };
  if (subpath && !options?.fullDepth && (await hasSkillMd(searchPath))) {
    let skill = await parseSkillMd(join(searchPath, 'SKILL.md'), options);
    if (skill) {
      skill = enhanceSkill(skill);
      return [skill];
    }
  }
  const manifestSkillDirs = await getPluginSkillPaths(searchPath);
  const skillMdPaths = await scanRepoForFilenames(searchPath, ['SKILL.md']);
  const allSkillMdPaths = new Set(skillMdPaths);
  for (const skillDir of manifestSkillDirs) {
    if (await hasSkillMd(skillDir)) {
      allSkillMdPaths.add(join(skillDir, 'SKILL.md'));
    }
  }
  const skills: Skill[] = [];
  const seenPaths = new Set<string>();
  for (const skillMdPath of allSkillMdPaths) {
    const resolvedPath = resolve(skillMdPath);
    if (seenPaths.has(resolvedPath)) continue;
    seenPaths.add(resolvedPath);
    let skill = await parseSkillMd(skillMdPath, options);
    if (skill) {
      skill = enhanceSkill(skill);
      skills.push(skill);
    }
  }
  const manifestRanks = new Map(manifestSkillDirs.map((dir, index) => [resolve(dir), index]));
  return skills.sort((a, b) => {
    const aManifest = manifestRanks.get(resolve(a.path));
    const bManifest = manifestRanks.get(resolve(b.path));
    if (aManifest !== undefined || bManifest !== undefined) {
      if (aManifest === undefined) return 1;
      if (bManifest === undefined) return -1;
      if (aManifest !== bManifest) return aManifest - bManifest;
    }
    const rankDiff =
      priorityRankForPath(join(a.path, 'SKILL.md'), searchPath, SKILL_PRIORITY_DIRS) -
      priorityRankForPath(join(b.path, 'SKILL.md'), searchPath, SKILL_PRIORITY_DIRS);
    if (rankDiff !== 0) return rankDiff;
    return relative(searchPath, a.path).localeCompare(relative(searchPath, b.path));
  });
}
export function getSkillDisplayName(skill: Skill): string {
  return skill.name || basename(skill.path);
}
export function filterSkills(skills: Skill[], inputNames: string[]): Skill[] {
  const normalizedInputs = inputNames.map((n) => n.toLowerCase());
  return skills.filter((skill) => {
    const name = skill.name.toLowerCase();
    const displayName = getSkillDisplayName(skill).toLowerCase();
    return normalizedInputs.some((input) => input === name || input === displayName);
  });
}
export function getDuplicateSkillNameGroups(skills: Skill[]): Map<string, Skill[]> {
  const byName = new Map<string, Skill[]>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    const group = byName.get(key) || [];
    group.push(skill);
    byName.set(key, group);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) byName.delete(name);
  }
  return byName;
}
