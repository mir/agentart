import { isRecord, parseFrontmatter } from '../util/frontmatter.ts';
import { sanitizeMetadata } from '../util/sanitize.ts';
import type { Skill } from '../core/artifacts.ts';
import { DEFAULT_REPO_SCAN_MAX_DEPTH } from '../repo/scan.ts';
import { SKILL_PRIORITY_DIRS } from './skills.ts';
export interface SkillSnapshotFile {
  path: string;
  contents: string;
}
export interface SkillDownloadResponse {
  files: SkillSnapshotFile[];
  hash: string; // skillsComputedHash
}
export interface BlobSkill extends Skill {
  files: SkillSnapshotFile[];
  snapshotHash: string;
  repoPath: string;
}
const DOWNLOAD_BASE_URL = process.env.SLOPRIDER_DOWNLOAD_URL || 'https://skills.sh';
const FETCH_TIMEOUT = 10_000;
export function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}
export interface RepoTree {
  sha: string;
  branch: string;
  tree: TreeEntry[];
}
export async function fetchRepoTree(
  ownerRepo: string,
  ref?: string,
  token?: string | null
): Promise<RepoTree | null> {
  const branches = ref ? [ref] : ['HEAD', 'main', 'master'];
  for (const branch of branches) {
    try {
      const url = `https://api.github.com/repos/${ownerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'sloprider-cli',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as {
        sha: string;
        tree: TreeEntry[];
      };
      return { sha: data.sha, branch, tree: data.tree };
    } catch {
      continue;
    }
  }
  return null;
}
export function getSkillFolderHashFromTree(tree: RepoTree, skillPath: string): string | null {
  let folderPath = skillPath.replace(/\\/g, '/');
  if (folderPath.toLowerCase().endsWith('/skill.md')) {
    folderPath = folderPath.slice(0, -9);
  } else if (folderPath.toLowerCase().endsWith('skill.md')) {
    folderPath = folderPath.slice(0, -8);
  }
  if (folderPath.endsWith('/')) {
    folderPath = folderPath.slice(0, -1);
  }
  if (!folderPath) {
    return tree.sha;
  }
  const entry = tree.tree.find((e) => e.type === 'tree' && e.path === folderPath);
  return entry?.sha ?? null;
}
const TREE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);
export function findSkillMdPaths(tree: RepoTree, subpath?: string): string[] {
  const normalizedSubpath = subpath?.replace(/^\/+|\/+$/g, '');
  if (normalizedSubpath) {
    const directPath = `${normalizedSubpath}/SKILL.md`;
    if (tree.tree.some((e) => e.type === 'blob' && e.path === directPath)) {
      return [directPath];
    }
  }
  const allSkillMds = tree.tree
    .filter((e) => {
      if (e.type !== 'blob') return false;
      const parts = e.path.split('/');
      if (parts.at(-1) !== 'SKILL.md') return false;
      if (parts.slice(0, -1).some((part) => TREE_SKIP_DIRS.has(part))) return false;
      return parts.length - 1 <= DEFAULT_REPO_SCAN_MAX_DEPTH;
    })
    .map((e) => e.path);
  const prefix = normalizedSubpath ? normalizedSubpath + '/' : '';
  const filtered = normalizedSubpath
    ? allSkillMds.filter((p) => p.startsWith(prefix))
    : allSkillMds;
  if (filtered.length === 0) return [];
  const rank = (path: string) => {
    const relativePath = normalizedSubpath ? path.slice(prefix.length) : path;
    const skillDir = relativePath === 'SKILL.md' ? '' : relativePath.slice(0, -'/SKILL.md'.length);
    for (let i = 0; i < SKILL_PRIORITY_DIRS.length; i++) {
      const priority = SKILL_PRIORITY_DIRS[i]!;
      if (priority === '') {
        if (skillDir === '') return i;
      } else if (skillDir === priority || skillDir.startsWith(priority + '/')) {
        return i;
      }
    }
    return SKILL_PRIORITY_DIRS.length;
  };
  return filtered.sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });
}
async function fetchSkillMdContent(
  ownerRepo: string,
  branch: string,
  skillMdPath: string
): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${skillMdPath}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}
async function fetchSkillDownload(
  source: string,
  slug: string
): Promise<SkillDownloadResponse | null> {
  try {
    const [owner, repo] = source.split('/');
    const url = `${DOWNLOAD_BASE_URL}/api/download/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${encodeURIComponent(slug)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!response.ok) return null;
    return (await response.json()) as SkillDownloadResponse;
  } catch {
    return null;
  }
}
export interface BlobInstallResult {
  skills: BlobSkill[];
  tree: RepoTree;
}
export async function tryBlobInstall(
  ownerRepo: string,
  options: {
    subpath?: string;
    skillFilter?: string;
    ref?: string;
    token?: string | null;
    includeInternal?: boolean;
  } = {}
): Promise<BlobInstallResult | null> {
  const tree = await fetchRepoTree(ownerRepo, options.ref, options.token);
  if (!tree) return null;
  let skillMdPaths = findSkillMdPaths(tree, options.subpath);
  if (skillMdPaths.length === 0) return null;
  if (options.skillFilter) {
    const filterSlug = toSkillSlug(options.skillFilter);
    const filtered = skillMdPaths.filter((p) => {
      const parts = p.split('/');
      if (parts.length < 2) return false;
      const folderName = parts[parts.length - 2]!;
      return toSkillSlug(folderName) === filterSlug;
    });
    if (filtered.length > 0) {
      skillMdPaths = filtered;
    }
  }
  const mdFetches = await Promise.all(
    skillMdPaths.map(async (mdPath) => {
      const content = await fetchSkillMdContent(ownerRepo, tree.branch, mdPath);
      return { mdPath, content };
    })
  );
  const parsedSkills: Array<{
    mdPath: string;
    name: string;
    description: string;
    content: string;
    slug: string;
    metadata?: Record<string, unknown>;
  }> = [];
  for (const { mdPath, content } of mdFetches) {
    if (!content) continue;
    const { data } = parseFrontmatter(content);
    if (!data.description) continue;
    if (
      (data.name !== undefined && (typeof data.name !== 'string' || data.name.length === 0)) ||
      typeof data.description !== 'string'
    ) {
      continue;
    }
    const metadata = isRecord(data.metadata) ? data.metadata : undefined;
    const isInternal = metadata?.internal === true;
    if (isInternal && !options.includeInternal) continue;
    const pathParts = mdPath.replace(/\\/g, '/').split('/');
    const fallbackName =
      pathParts.length > 1 ? pathParts[pathParts.length - 2] : ownerRepo.split('/').at(-1);
    if (!fallbackName) continue;
    const safeName = sanitizeMetadata(data.name ?? fallbackName);
    const safeDescription = sanitizeMetadata(data.description);
    parsedSkills.push({
      mdPath,
      name: safeName,
      description: safeDescription,
      content,
      slug: toSkillSlug(safeName),
      metadata,
    });
  }
  if (parsedSkills.length === 0) return null;
  let filteredSkills = parsedSkills;
  if (options.skillFilter) {
    const filterSlug = toSkillSlug(options.skillFilter);
    const nameFiltered = parsedSkills.filter((s) => s.slug === filterSlug);
    if (nameFiltered.length > 0) {
      filteredSkills = nameFiltered;
    }
    if (filteredSkills.length === 0) return null;
  }
  const source = ownerRepo.toLowerCase();
  const downloads = await Promise.all(
    filteredSkills.map(async (skill) => {
      const download = await fetchSkillDownload(source, skill.slug);
      return { skill, download };
    })
  );
  const allSucceeded = downloads.every((d) => d.download !== null);
  if (!allSucceeded) return null;
  const blobSkills: BlobSkill[] = downloads.map(({ skill, download }) => {
    const mdPathLower = skill.mdPath.toLowerCase();
    const folderPath = mdPathLower.endsWith('/skill.md')
      ? skill.mdPath.slice(0, -9)
      : mdPathLower === 'skill.md'
        ? ''
        : skill.mdPath.slice(0, -(1 + 'SKILL.md'.length));
    return {
      name: skill.name,
      description: skill.description,
      path: '',
      rawContent: skill.content,
      metadata: skill.metadata,
      files: download!.files,
      snapshotHash: download!.hash,
      repoPath: skill.mdPath,
    };
  });
  return { skills: blobSkills, tree };
}
