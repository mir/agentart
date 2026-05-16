import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import { createHash } from 'crypto';
const LOCAL_LOCK_FILE = 'sloprider-lock.json';
const CURRENT_VERSION = 1;
export interface LocalSkillLockEntry {
  source: string;
  ref?: string;
  sourceType: string;
  skillPath?: string;
  computedHash: string;
  sourceSha?: string;
}
export interface LocalSkillLockFile {
  version: number;
  skills: Record<string, LocalSkillLockEntry>;
}
export function getLocalLockPath(cwd?: string): string {
  return join(cwd || process.cwd(), LOCAL_LOCK_FILE);
}
export async function readLocalLock(cwd?: string): Promise<LocalSkillLockFile> {
  const lockPath = getLocalLockPath(cwd);
  try {
    const content = await readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as LocalSkillLockFile;
    if (typeof parsed.version !== 'number' || !parsed.skills) {
      return createEmptyLocalLock();
    }
    if (parsed.version < CURRENT_VERSION) {
      return createEmptyLocalLock();
    }
    return parsed;
  } catch {
    return createEmptyLocalLock();
  }
}
export async function writeLocalLock(lock: LocalSkillLockFile, cwd?: string): Promise<void> {
  const lockPath = getLocalLockPath(cwd);
  const sortedSkills: Record<string, LocalSkillLockEntry> = {};
  for (const key of Object.keys(lock.skills).sort()) {
    sortedSkills[key] = lock.skills[key]!;
  }
  const sorted: LocalSkillLockFile = { version: lock.version, skills: sortedSkills };
  const content = JSON.stringify(sorted, null, 2) + '\n';
  await writeFile(lockPath, content, 'utf-8');
}
export async function computeSkillFolderHash(skillDir: string): Promise<string> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  await collectFiles(skillDir, skillDir, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest('hex');
}
async function collectFiles(
  baseDir: string,
  currentDir: string,
  results: Array<{ relativePath: string; content: Buffer }>
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') return;
        await collectFiles(baseDir, fullPath, results);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath);
        const relativePath = relative(baseDir, fullPath).split('\\').join('/');
        results.push({ relativePath, content });
      }
    })
  );
}
export async function addSkillToLocalLock(
  skillName: string,
  entry: LocalSkillLockEntry,
  cwd?: string
): Promise<void> {
  const lock = await readLocalLock(cwd);
  lock.skills[skillName] = entry;
  await writeLocalLock(lock, cwd);
}
export async function removeSkillFromLocalLock(skillName: string, cwd?: string): Promise<boolean> {
  const lock = await readLocalLock(cwd);
  if (!(skillName in lock.skills)) {
    return false;
  }
  delete lock.skills[skillName];
  await writeLocalLock(lock, cwd);
  return true;
}
function createEmptyLocalLock(): LocalSkillLockFile {
  return {
    version: CURRENT_VERSION,
    skills: {},
  };
}
