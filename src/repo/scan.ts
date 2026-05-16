import { readdir } from 'fs/promises';
import { join, relative } from 'path';
export const DEFAULT_REPO_SCAN_MAX_DEPTH = 10;
export const DEFAULT_REPO_SCAN_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
]);
export interface RepoScanOptions {
  maxDepth?: number;
  skipDirs?: Set<string>;
}
export interface RepoScanPathMatch {
  fullPath: string;
  relPath: string;
  name: string;
}
export function normalizeRepoRelativePath(path: string): string {
  return path.split('\\').join('/');
}
export function repoPathMatchesSuffix(path: string, suffix: string): boolean {
  const normalized = normalizeRepoRelativePath(path);
  const normalizedSuffix = normalizeRepoRelativePath(suffix).replace(/^\/+/g, '');
  return normalized === normalizedSuffix || normalized.endsWith(`/${normalizedSuffix}`);
}
export function repoPathMatchesBasename(path: string, filename: string): boolean {
  const normalized = normalizeRepoRelativePath(path);
  return normalized.split('/').pop() === filename;
}
export async function scanRepoForPathMatches(
  basePath: string,
  matches: (entry: RepoScanPathMatch) => boolean,
  options: RepoScanOptions = {}
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_REPO_SCAN_MAX_DEPTH;
  const skipDirs = options.skipDirs ?? DEFAULT_REPO_SCAN_SKIP_DIRS;
  const results: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        const relPath = normalizeRepoRelativePath(relative(basePath, fullPath));
        if (matches({ fullPath, relPath, name: entry.name })) results.push(fullPath);
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (skipDirs.has(entry.name)) continue;
      if (depth >= maxDepth) continue;
      await walk(fullPath, depth + 1);
    }
  }
  await walk(basePath, 0);
  return results.sort((a, b) => relative(basePath, a).localeCompare(relative(basePath, b)));
}
export async function scanRepoForFilenames(
  basePath: string,
  filenames: string[],
  options: RepoScanOptions = {}
): Promise<string[]> {
  const wanted = new Set(filenames);
  return scanRepoForPathMatches(basePath, ({ name }) => wanted.has(name), options);
}
export function priorityRankForPath(
  path: string,
  basePath: string,
  priorityDirs: string[]
): number {
  const normalized = normalizeRepoRelativePath(relative(basePath, path));
  const skillDir = normalized.endsWith('/SKILL.md')
    ? normalized.slice(0, -'/SKILL.md'.length)
    : normalized === 'SKILL.md'
      ? ''
      : normalized;
  for (let i = 0; i < priorityDirs.length; i++) {
    const priority = priorityDirs[i]!.replace(/\/+$/g, '');
    if (priority === '') {
      if (skillDir === '') return i;
      continue;
    }
    if (skillDir === priority || skillDir.startsWith(priority + '/')) return i;
  }
  return priorityDirs.length;
}
