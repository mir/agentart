import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
const AGENTS_DIR = '.agents';
const LOCK_FILE = '.skill-lock.json';
const CURRENT_VERSION = 3; // Bumped from 2 to 3 for folder hash support (GitHub tree SHA)
export interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  skillFolderHash: string;
  sourceSha?: string;
  installedAt: string;
  updatedAt: string;
  pluginName?: string;
}
export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
  lastSelectedAgents?: string[];
}
export function getSkillLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) {
    return join(xdgStateHome, 'sloprider', LOCK_FILE);
  }
  return join(homedir(), AGENTS_DIR, LOCK_FILE);
}
export async function readSkillLock(): Promise<SkillLockFile> {
  const lockPath = getSkillLockPath();
  try {
    const content = await readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as SkillLockFile;
    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return createEmptyLockFile();
    }
    if (parsed.version < CURRENT_VERSION) {
      return createEmptyLockFile();
    }
    return parsed;
  } catch (error) {
    return createEmptyLockFile();
  }
}
export async function writeSkillLock(lock: SkillLockFile): Promise<void> {
  const lockPath = getSkillLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const content = JSON.stringify(lock, null, 2);
  await writeFile(lockPath, content, 'utf-8');
}
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}
export function getGitHubToken(): string | null {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) {
      return token;
    }
  } catch {}
  return null;
}
export async function fetchSkillFolderHash(
  ownerRepo: string,
  skillPath: string,
  token?: string | null,
  ref?: string
): Promise<string | null> {
  const { fetchRepoTree, getSkillFolderHashFromTree } = await import('./skills.ts');
  const tree = await fetchRepoTree(ownerRepo, ref, token);
  if (!tree) return null;
  return getSkillFolderHashFromTree(tree, skillPath);
}
export async function addSkillToLock(
  skillName: string,
  entry: Omit<SkillLockEntry, 'installedAt' | 'updatedAt'>
): Promise<SkillLockEntry> {
  const lock = await readSkillLock();
  const now = new Date().toISOString();
  const existingEntry = lock.skills[skillName];
  const nextEntry: SkillLockEntry = {
    ...entry,
    installedAt: existingEntry?.installedAt ?? now,
    updatedAt: now,
  };
  lock.skills[skillName] = nextEntry;
  await writeSkillLock(lock);
  return nextEntry;
}
export async function removeSkillFromLock(skillName: string): Promise<boolean> {
  const lock = await readSkillLock();
  if (!(skillName in lock.skills)) {
    return false;
  }
  delete lock.skills[skillName];
  await writeSkillLock(lock);
  return true;
}
export async function getSkillFromLock(skillName: string): Promise<SkillLockEntry | null> {
  const lock = await readSkillLock();
  return lock.skills[skillName] ?? null;
}
export async function getAllLockedSkills(): Promise<Record<string, SkillLockEntry>> {
  const lock = await readSkillLock();
  return lock.skills;
}
export async function getSkillsBySource(): Promise<
  Map<string, { skills: string[]; entry: SkillLockEntry }>
> {
  const lock = await readSkillLock();
  const bySource = new Map<string, { skills: string[]; entry: SkillLockEntry }>();
  for (const [skillName, entry] of Object.entries(lock.skills)) {
    const existing = bySource.get(entry.source);
    if (existing) {
      existing.skills.push(skillName);
    } else {
      bySource.set(entry.source, { skills: [skillName], entry });
    }
  }
  return bySource;
}
function createEmptyLockFile(): SkillLockFile {
  return {
    version: CURRENT_VERSION,
    skills: {},
  };
}
export async function getLastSelectedAgents(): Promise<string[] | undefined> {
  const lock = await readSkillLock();
  return lock.lastSelectedAgents;
}
export async function saveSelectedAgents(agents: string[]): Promise<void> {
  const lock = await readSkillLock();
  lock.lastSelectedAgents = agents;
  await writeSkillLock(lock);
}
