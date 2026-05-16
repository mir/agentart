import {
  mkdir,
  cp,
  access,
  readdir,
  symlink,
  lstat,
  rm,
  readlink,
  writeFile,
  stat,
  realpath,
} from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, normalize, resolve, sep, relative, dirname } from 'path';
import { homedir, platform } from 'os';
import type { Skill } from '../core/artifacts.ts';
import type { AgentType } from '../core/agents.ts';
import { agents, detectInstalledAgents, isUniversalAgent } from '../core/agents.ts';
import { AGENTS_DIR, SKILLS_SUBDIR } from '../constants.ts';
import { parseSkillMd } from './skills.ts';
export type InstallMode = 'symlink' | 'copy';
interface InstallResult {
  success: boolean;
  path: string;
  canonicalPath?: string;
  mode: InstallMode;
  symlinkFailed?: boolean;
  skipped?: boolean;
  error?: string;
}
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '');
  return sanitized.substring(0, 255) || 'unnamed-skill';
}
function isPathSafe(basePath: string, installedPath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(installedPath));
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}
async function isDirEntryOrSymlinkToDir(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  entryPath: string
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(entryPath)).isDirectory();
  } catch {
    return false;
  }
}
export function getCanonicalSkillsDir(global: boolean, cwd?: string): string {
  const baseDir = global ? homedir() : cwd || process.cwd();
  return join(baseDir, AGENTS_DIR, SKILLS_SUBDIR);
}
export function getAgentBaseDir(agentType: AgentType, global: boolean, cwd?: string): string {
  if (isUniversalAgent(agentType)) {
    return getCanonicalSkillsDir(global, cwd);
  }
  const agent = agents[agentType];
  const baseDir = global ? homedir() : cwd || process.cwd();
  if (global) {
    if (agent.globalSkillsDir === undefined) {
      return join(baseDir, agent.skillsDir);
    }
    return agent.globalSkillsDir;
  }
  return join(baseDir, agent.skillsDir);
}
function resolveSymlinkTarget(linkPath: string, linkTarget: string): string {
  return resolve(dirname(linkPath), linkTarget);
}
async function cleanAndCreateDirectory(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {}
  await mkdir(path, { recursive: true });
}
async function resolveParentSymlinks(path: string): Promise<string> {
  const resolved = resolve(path);
  const dir = dirname(resolved);
  const base = basename(resolved);
  try {
    const realDir = await realpath(dir);
    return join(realDir, base);
  } catch {
    return resolved;
  }
}
async function createSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    const resolvedTarget = resolve(target);
    const resolvedLinkPath = resolve(linkPath);
    const [realTarget, realLinkPath] = await Promise.all([
      realpath(resolvedTarget).catch(() => resolvedTarget),
      realpath(resolvedLinkPath).catch(() => resolvedLinkPath),
    ]);
    if (realTarget === realLinkPath) {
      return true;
    }
    const realTargetWithParents = await resolveParentSymlinks(target);
    const realLinkPathWithParents = await resolveParentSymlinks(linkPath);
    if (realTargetWithParents === realLinkPathWithParents) {
      return true;
    }
    try {
      const stats = await lstat(linkPath);
      if (stats.isSymbolicLink()) {
        const existingTarget = await readlink(linkPath);
        if (resolveSymlinkTarget(linkPath, existingTarget) === resolvedTarget) {
          return true;
        }
        await rm(linkPath);
      } else {
        await rm(linkPath, { recursive: true });
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ELOOP') {
        try {
          await rm(linkPath, { force: true });
        } catch {}
      }
    }
    const linkDir = dirname(linkPath);
    await mkdir(linkDir, { recursive: true });
    const realLinkDir = await resolveParentSymlinks(linkDir);
    const relativePath = relative(realLinkDir, target);
    const symlinkType = platform() === 'win32' ? 'junction' : undefined;
    await symlink(relativePath, linkPath, symlinkType);
    return true;
  } catch {
    return false;
  }
}
export async function installSkillForAgent(
  skill: Skill,
  agentType: AgentType,
  options: { global?: boolean; cwd?: string; mode?: InstallMode } = {}
): Promise<InstallResult> {
  const agent = agents[agentType];
  const isGlobal = options.global ?? false;
  const cwd = options.cwd || process.cwd();
  if (isGlobal && agent.globalSkillsDir === undefined) {
    return {
      success: false,
      path: '',
      mode: options.mode ?? 'symlink',
      error: `${agent.displayName} does not support global skill installation`,
    };
  }
  const rawSkillName = skill.name || basename(skill.path);
  const skillName = sanitizeName(rawSkillName);
  const canonicalBase = getCanonicalSkillsDir(isGlobal, cwd);
  const canonicalDir = join(canonicalBase, skillName);
  const agentBase = getAgentBaseDir(agentType, isGlobal, cwd);
  const agentDir = join(agentBase, skillName);
  const installMode = options.mode ?? 'symlink';
  if (!isPathSafe(canonicalBase, canonicalDir)) {
    return {
      success: false,
      path: agentDir,
      mode: installMode,
      error: 'Invalid skill name: potential path traversal detected',
    };
  }
  if (!isPathSafe(agentBase, agentDir)) {
    return {
      success: false,
      path: agentDir,
      mode: installMode,
      error: 'Invalid skill name: potential path traversal detected',
    };
  }
  try {
    if (installMode === 'copy') {
      await cleanAndCreateDirectory(agentDir);
      await copyDirectory(skill.path, agentDir);
      return {
        success: true,
        path: agentDir,
        mode: 'copy',
      };
    }
    await cleanAndCreateDirectory(canonicalDir);
    await copyDirectory(skill.path, canonicalDir);
    if (isGlobal && isUniversalAgent(agentType)) {
      return {
        success: true,
        path: canonicalDir,
        canonicalPath: canonicalDir,
        mode: 'symlink',
      };
    }
    if (!isGlobal && !isUniversalAgent(agentType)) {
      const agentRootDir = join(cwd, agents[agentType].skillsDir.split('/')[0]!);
      if (!existsSync(agentRootDir)) {
        return {
          success: true,
          path: canonicalDir,
          canonicalPath: canonicalDir,
          mode: 'symlink',
          skipped: true,
        };
      }
    }
    const symlinkCreated = await createSymlink(canonicalDir, agentDir);
    if (!symlinkCreated) {
      await cleanAndCreateDirectory(agentDir);
      await copyDirectory(skill.path, agentDir);
      return {
        success: true,
        path: agentDir,
        canonicalPath: canonicalDir,
        mode: 'symlink',
        symlinkFailed: true,
      };
    }
    return {
      success: true,
      path: agentDir,
      canonicalPath: canonicalDir,
      mode: 'symlink',
    };
  } catch (error) {
    return {
      success: false,
      path: agentDir,
      mode: installMode,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
const EXCLUDE_FILES = new Set(['metadata.json']);
const EXCLUDE_DIRS = new Set(['.git', '__pycache__', '__pypackages__']);
const isExcluded = (name: string, isDirectory: boolean = false): boolean => {
  if (EXCLUDE_FILES.has(name)) return true;
  if (isDirectory && EXCLUDE_DIRS.has(name)) return true;
  return false;
};
async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => !isExcluded(entry.name, entry.isDirectory()))
      .map(async (entry) => {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          await copyDirectory(srcPath, destPath);
        } else {
          try {
            await cp(srcPath, destPath, {
              dereference: true,
              recursive: true,
            });
          } catch (err: unknown) {
            if (
              err instanceof Error &&
              'code' in err &&
              (err as NodeJS.ErrnoException).code === 'ENOENT' &&
              entry.isSymbolicLink()
            ) {
              console.warn(`Skipping broken symlink: ${srcPath}`);
            } else {
              throw err;
            }
          }
        }
      })
  );
}
export async function isSkillInstalled(
  skillName: string,
  agentType: AgentType,
  options: { global?: boolean; cwd?: string } = {}
): Promise<boolean> {
  const agent = agents[agentType];
  const sanitized = sanitizeName(skillName);
  if (options.global && agent.globalSkillsDir === undefined) {
    return false;
  }
  const targetBase = options.global
    ? agent.globalSkillsDir!
    : join(options.cwd || process.cwd(), agent.skillsDir);
  const skillDir = join(targetBase, sanitized);
  if (!isPathSafe(targetBase, skillDir)) {
    return false;
  }
  try {
    await access(skillDir);
    return true;
  } catch {
    return false;
  }
}
export function getInstallPath(
  skillName: string,
  agentType: AgentType,
  options: { global?: boolean; cwd?: string } = {}
): string {
  const agent = agents[agentType];
  const cwd = options.cwd || process.cwd();
  const sanitized = sanitizeName(skillName);
  const targetBase = getAgentBaseDir(agentType, options.global ?? false, options.cwd);
  const installPath = join(targetBase, sanitized);
  if (!isPathSafe(targetBase, installPath)) {
    throw new Error('Invalid skill name: potential path traversal detected');
  }
  return installPath;
}
export function getCanonicalPath(
  skillName: string,
  options: { global?: boolean; cwd?: string } = {}
): string {
  const sanitized = sanitizeName(skillName);
  const canonicalBase = getCanonicalSkillsDir(options.global ?? false, options.cwd);
  const canonicalPath = join(canonicalBase, sanitized);
  if (!isPathSafe(canonicalBase, canonicalPath)) {
    throw new Error('Invalid skill name: potential path traversal detected');
  }
  return canonicalPath;
}
export async function installBlobSkillForAgent(
  skill: { installName: string; files: Array<{ path: string; contents: string }> },
  agentType: AgentType,
  options: { global?: boolean; cwd?: string; mode?: InstallMode } = {}
): Promise<InstallResult> {
  const agent = agents[agentType];
  const isGlobal = options.global ?? false;
  const cwd = options.cwd || process.cwd();
  const installMode = options.mode ?? 'symlink';
  if (isGlobal && agent.globalSkillsDir === undefined) {
    return {
      success: false,
      path: '',
      mode: installMode,
      error: `${agent.displayName} does not support global skill installation`,
    };
  }
  const skillName = sanitizeName(skill.installName);
  const canonicalBase = getCanonicalSkillsDir(isGlobal, cwd);
  const canonicalDir = join(canonicalBase, skillName);
  const agentBase = getAgentBaseDir(agentType, isGlobal, cwd);
  const agentDir = join(agentBase, skillName);
  if (!isPathSafe(canonicalBase, canonicalDir)) {
    return {
      success: false,
      path: agentDir,
      mode: installMode,
      error: 'Invalid skill name: potential path traversal detected',
    };
  }
  if (!isPathSafe(agentBase, agentDir)) {
    return {
      success: false,
      path: agentDir,
      mode: installMode,
      error: 'Invalid skill name: potential path traversal detected',
    };
  }
  async function writeSkillFiles(targetDir: string): Promise<void> {
    for (const file of skill.files) {
      const fullPath = join(targetDir, file.path);
      if (!isPathSafe(targetDir, fullPath)) continue;
      const parentDir = dirname(fullPath);
      if (parentDir !== targetDir) {
        await mkdir(parentDir, { recursive: true });
      }
      await writeFile(fullPath, file.contents, 'utf-8');
    }
  }
  try {
    if (installMode === 'copy') {
      await cleanAndCreateDirectory(agentDir);
      await writeSkillFiles(agentDir);
      return { success: true, path: agentDir, mode: 'copy' };
    }
    await cleanAndCreateDirectory(canonicalDir);
    await writeSkillFiles(canonicalDir);
    if (isGlobal && isUniversalAgent(agentType)) {
      return {
        success: true,
        path: canonicalDir,
        canonicalPath: canonicalDir,
        mode: 'symlink',
      };
    }
    if (!isGlobal && !isUniversalAgent(agentType)) {
      const agentRootDir = join(cwd, agents[agentType].skillsDir.split('/')[0]!);
      if (!existsSync(agentRootDir)) {
        return {
          success: true,
          path: canonicalDir,
          canonicalPath: canonicalDir,
          mode: 'symlink',
          skipped: true,
        };
      }
    }
    const symlinkCreated = await createSymlink(canonicalDir, agentDir);
    if (!symlinkCreated) {
      await cleanAndCreateDirectory(agentDir);
      await writeSkillFiles(agentDir);
      return {
        success: true,
        path: agentDir,
        canonicalPath: canonicalDir,
        mode: 'symlink',
        symlinkFailed: true,
      };
    }
    return {
      success: true,
      path: agentDir,
      canonicalPath: canonicalDir,
      mode: 'symlink',
    };
  } catch (error) {
    return {
      success: false,
      path: agentDir,
      mode: installMode,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
export interface InstalledSkill {
  name: string;
  description: string;
  path: string;
  canonicalPath: string;
  scope: 'project' | 'global';
  agents: AgentType[];
}
export async function listInstalledSkills(
  options: {
    global?: boolean;
    cwd?: string;
    agentFilter?: AgentType[];
  } = {}
): Promise<InstalledSkill[]> {
  const cwd = options.cwd || process.cwd();
  const skillsMap: Map<string, InstalledSkill> = new Map();
  const scopes: Array<{ global: boolean; path: string; agentType?: AgentType }> = [];
  const detectedAgents = await detectInstalledAgents();
  const agentFilter = options.agentFilter;
  const agentsToCheck = agentFilter
    ? detectedAgents.filter((a) => agentFilter.includes(a))
    : detectedAgents;
  const scopeTypes: Array<{ global: boolean }> = [];
  if (options.global === undefined) {
    scopeTypes.push({ global: false }, { global: true });
  } else {
    scopeTypes.push({ global: options.global });
  }
  for (const { global: isGlobal } of scopeTypes) {
    scopes.push({ global: isGlobal, path: getCanonicalSkillsDir(isGlobal, cwd) });
    for (const agentType of agentsToCheck) {
      const agent = agents[agentType];
      if (isGlobal && agent.globalSkillsDir === undefined) {
        continue;
      }
      const agentDir = isGlobal ? agent.globalSkillsDir! : join(cwd, agent.skillsDir);
      if (!scopes.some((s) => s.path === agentDir && s.global === isGlobal)) {
        scopes.push({ global: isGlobal, path: agentDir, agentType });
      }
    }
    const allAgentTypes = Object.keys(agents) as AgentType[];
    for (const agentType of allAgentTypes) {
      if (agentsToCheck.includes(agentType)) continue;
      const agent = agents[agentType];
      if (isGlobal && agent.globalSkillsDir === undefined) continue;
      const agentDir = isGlobal ? agent.globalSkillsDir! : join(cwd, agent.skillsDir);
      if (scopes.some((s) => s.path === agentDir && s.global === isGlobal)) continue;
      if (existsSync(agentDir)) {
        scopes.push({ global: isGlobal, path: agentDir, agentType });
      }
    }
  }
  for (const scope of scopes) {
    try {
      const entries = await readdir(scope.path, { withFileTypes: true });
      for (const entry of entries) {
        const skillDir = join(scope.path, entry.name);
        if (!(await isDirEntryOrSymlinkToDir(entry, skillDir))) continue;
        const skillMdPath = join(skillDir, 'SKILL.md');
        try {
          await stat(skillMdPath);
        } catch {
          continue;
        }
        const skill = await parseSkillMd(skillMdPath);
        if (!skill) {
          continue;
        }
        const scopeKey = scope.global ? 'global' : 'project';
        const skillKey = `${scopeKey}:${skill.name}`;
        if (scope.agentType) {
          if (skillsMap.has(skillKey)) {
            const existing = skillsMap.get(skillKey)!;
            if (!existing.agents.includes(scope.agentType)) {
              existing.agents.push(scope.agentType);
            }
          } else {
            skillsMap.set(skillKey, {
              name: skill.name,
              description: skill.description,
              path: skillDir,
              canonicalPath: skillDir,
              scope: scopeKey,
              agents: [scope.agentType],
            });
          }
          continue;
        }
        const sanitizedSkillName = sanitizeName(skill.name);
        const installedAgents: AgentType[] = [];
        for (const agentType of agentsToCheck) {
          const agent = agents[agentType];
          if (scope.global && agent.globalSkillsDir === undefined) {
            continue;
          }
          const agentBase = scope.global ? agent.globalSkillsDir! : join(cwd, agent.skillsDir);
          let found = false;
          const possibleNames = Array.from(
            new Set([
              entry.name,
              sanitizedSkillName,
              skill.name
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[\/\\:\0]/g, ''),
            ])
          );
          for (const possibleName of possibleNames) {
            const agentSkillDir = join(agentBase, possibleName);
            if (!isPathSafe(agentBase, agentSkillDir)) continue;
            try {
              await access(agentSkillDir);
              found = true;
              break;
            } catch {}
          }
          if (!found) {
            try {
              const agentEntries = await readdir(agentBase, { withFileTypes: true });
              for (const agentEntry of agentEntries) {
                const candidateDir = join(agentBase, agentEntry.name);
                if (!(await isDirEntryOrSymlinkToDir(agentEntry, candidateDir))) continue;
                if (!isPathSafe(agentBase, candidateDir)) continue;
                try {
                  const candidateSkillMd = join(candidateDir, 'SKILL.md');
                  await stat(candidateSkillMd);
                  const candidateSkill = await parseSkillMd(candidateSkillMd);
                  if (candidateSkill && candidateSkill.name === skill.name) {
                    found = true;
                    break;
                  }
                } catch {}
              }
            } catch {}
          }
          if (found) {
            installedAgents.push(agentType);
          }
        }
        if (skillsMap.has(skillKey)) {
          const existing = skillsMap.get(skillKey)!;
          for (const agent of installedAgents) {
            if (!existing.agents.includes(agent)) {
              existing.agents.push(agent);
            }
          }
        } else {
          skillsMap.set(skillKey, {
            name: skill.name,
            description: skill.description,
            path: skillDir,
            canonicalPath: skillDir,
            scope: scopeKey,
            agents: installedAgents,
          });
        }
      }
    } catch {}
  }
  return Array.from(skillsMap.values());
}
