/**
 * Blob-based skill download utilities.
 *
 * Enables fast skill installation by fetching pre-built skill snapshots
 * from the skills.sh download API instead of cloning git repos.
 *
 * Flow:
 *   1. GitHub Trees API → discover SKILL.md locations
 *   2. raw.githubusercontent.com → fetch frontmatter to get skill names
 *   3. skills.sh/api/download → fetch full file contents from cached blob
 */

import { isRecord, parseFrontmatter } from './frontmatter.ts';
import { sanitizeMetadata } from './sanitize.ts';
import type { Skill } from './types.ts';
import { DEFAULT_REPO_SCAN_MAX_DEPTH } from './repo-scan.ts';
import { SKILL_PRIORITY_DIRS } from './skills.ts';

// ─── Types ───

export interface SkillSnapshotFile {
  path: string;
  contents: string;
}

export interface SkillDownloadResponse {
  files: SkillSnapshotFile[];
  hash: string; // skillsComputedHash
}

/**
 * A skill resolved from blob storage, carrying file contents in memory
 * instead of referencing a directory on disk.
 */
export interface BlobSkill extends Skill {
  /** Files from the blob snapshot */
  files: SkillSnapshotFile[];
  /** skillsComputedHash from the blob snapshot */
  snapshotHash: string;
  /** Path of the SKILL.md within the repo (e.g., "skills/react-best-practices/SKILL.md") */
  repoPath: string;
}

// ─── Constants ───

const DOWNLOAD_BASE_URL = process.env.SLOPRIDER_DOWNLOAD_URL || 'https://skills.sh';

/** Timeout for individual HTTP fetches (ms) */
const FETCH_TIMEOUT = 10_000;

// ─── Slug computation ───

/**
 * Convert a skill name to a URL-safe slug.
 * Must match the server-side toSkillSlug() exactly.
 */
export function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── GitHub Trees API ───

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

/**
 * Fetch the full recursive tree for a GitHub repo.
 * Returns the tree data including all entries, or null on failure.
 * Tries branches in order: ref (if specified), then main, then master.
 */
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

/**
 * Extract the folder hash (tree SHA) for a specific skill path from a repo tree.
 * This replaces the per-skill GitHub API call previously done in fetchSkillFolderHash().
 */
export function getSkillFolderHashFromTree(tree: RepoTree, skillPath: string): string | null {
  let folderPath = skillPath.replace(/\\/g, '/');

  // Remove SKILL.md suffix to get folder path (case-insensitive)
  if (folderPath.toLowerCase().endsWith('/skill.md')) {
    folderPath = folderPath.slice(0, -9);
  } else if (folderPath.toLowerCase().endsWith('skill.md')) {
    folderPath = folderPath.slice(0, -8);
  }
  if (folderPath.endsWith('/')) {
    folderPath = folderPath.slice(0, -1);
  }

  // Root-level skill
  if (!folderPath) {
    return tree.sha;
  }

  const entry = tree.tree.find((e) => e.type === 'tree' && e.path === folderPath);
  return entry?.sha ?? null;
}

// ─── Skill discovery from tree ───

const TREE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);

/**
 * Find all SKILL.md file paths in a repo tree.
 * Applies the same priority directory logic as discoverSkills().
 * If subpath is set, only searches within that subtree.
 */
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

// ─── Fetching skill content ───

/**
 * Fetch a single SKILL.md from raw.githubusercontent.com to get frontmatter.
 * Returns the raw content string, or null on failure.
 */
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

/**
 * Fetch a skill's full file contents from the skills.sh download API.
 * Returns the files array and content hash, or null on failure.
 */
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

// ─── Main entry point ───

export interface BlobInstallResult {
  skills: BlobSkill[];
  tree: RepoTree;
}

/**
 * Attempt to resolve skills from blob storage instead of cloning.
 *
 * Steps:
 *   1. Fetch repo tree from GitHub Trees API
 *   2. Discover SKILL.md paths from the tree
 *   3. Fetch SKILL.md content from raw.githubusercontent.com (for frontmatter/name)
 *   4. Compute slugs and fetch full snapshots from skills.sh download API
 *
 * Returns the resolved BlobSkills + tree data on success, or null on any failure
 * (the caller should fall back to git clone).
 *
 * @param ownerRepo - e.g., "vercel-labs/agent-skills"
 * @param options - subpath, skillFilter, ref, token
 */
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
  // 1. Fetch the full repo tree
  const tree = await fetchRepoTree(ownerRepo, options.ref, options.token);
  if (!tree) return null;

  // 2. Discover SKILL.md paths in the tree
  let skillMdPaths = findSkillMdPaths(tree, options.subpath);
  if (skillMdPaths.length === 0) return null;

  // 3. If a skill filter is set (owner/repo@skill-name), try to narrow down
  if (options.skillFilter) {
    const filterSlug = toSkillSlug(options.skillFilter);
    const filtered = skillMdPaths.filter((p) => {
      // Match by folder name — e.g., "skills/react-best-practices/SKILL.md"
      const parts = p.split('/');
      if (parts.length < 2) return false;
      const folderName = parts[parts.length - 2]!;
      return toSkillSlug(folderName) === filterSlug;
    });
    if (filtered.length > 0) {
      skillMdPaths = filtered;
    }
    // If no match by folder name, we'll try matching by frontmatter name below
  }

  // 4. Fetch SKILL.md content from raw.githubusercontent.com in parallel
  const mdFetches = await Promise.all(
    skillMdPaths.map(async (mdPath) => {
      const content = await fetchSkillMdContent(ownerRepo, tree.branch, mdPath);
      return { mdPath, content };
    })
  );

  // Parse frontmatter to get skill names
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

    // Skip internal skills unless explicitly requested
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

  // Apply skill filter by name if not already filtered by folder name
  let filteredSkills = parsedSkills;
  if (options.skillFilter) {
    const filterSlug = toSkillSlug(options.skillFilter);
    const nameFiltered = parsedSkills.filter((s) => s.slug === filterSlug);
    if (nameFiltered.length > 0) {
      filteredSkills = nameFiltered;
    }
    // If still no match, let the caller fall back to clone where
    // filterSkills() does fuzzy matching
    if (filteredSkills.length === 0) return null;
  }

  // 5. Fetch full snapshots from skills.sh download API in parallel
  const source = ownerRepo.toLowerCase();
  const downloads = await Promise.all(
    filteredSkills.map(async (skill) => {
      const download = await fetchSkillDownload(source, skill.slug);
      return { skill, download };
    })
  );

  // If ANY download failed, fall back to clone — we don't do partial blob installs
  const allSucceeded = downloads.every((d) => d.download !== null);
  if (!allSucceeded) return null;

  // 6. Convert to BlobSkill objects
  const blobSkills: BlobSkill[] = downloads.map(({ skill, download }) => {
    // Compute the folder path from the SKILL.md path (e.g., "skills/react-best-practices")
    const mdPathLower = skill.mdPath.toLowerCase();
    const folderPath = mdPathLower.endsWith('/skill.md')
      ? skill.mdPath.slice(0, -9)
      : mdPathLower === 'skill.md'
        ? ''
        : skill.mdPath.slice(0, -(1 + 'SKILL.md'.length));

    return {
      name: skill.name,
      description: skill.description,
      // BlobSkills don't have a disk path — set to empty string.
      // The installer uses the files array directly.
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
