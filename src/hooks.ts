import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import * as p from '@clack/prompts';
import { agents } from './agents.ts';
import {
  addHookToLock,
  readHookLock,
  removeHookFromLock,
  type HookLockEntry,
} from './hook-lock.ts';
import {
  normalizeRepoRelativePath,
  repoPathMatchesSuffix,
  scanRepoForPathMatches,
} from './repo-scan.ts';
import type { AgentType, ParsedSource } from './types.ts';

export type HookAgent = Extract<AgentType, 'codex' | 'claude-code' | 'github-copilot'>;

export interface DiscoveredHookBundle {
  name: string;
  agent: HookAgent;
  sourcePath: string;
  events: string[];
  hooks: Record<string, unknown>;
}

export interface InstalledHookBundle {
  name: string;
  agent: HookAgent;
  scope: 'project';
  events: string[];
  targetPath: string;
  sourcePath: string;
}

type InstallResult = { success: boolean; name: string; agent: HookAgent; error?: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonStrict(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, 'utf-8'));
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

async function readJsonOrDefault(path: string, fallback: Record<string, unknown>) {
  try {
    return await readJsonStrict(path);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { ...fallback };
    }
    throw error;
  }
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}

function normalizeRel(path: string): string {
  return normalizeRepoRelativePath(path);
}

function eventsFromHooks(hooks: Record<string, unknown>): string[] {
  return Object.keys(hooks).filter((event) => {
    const value = hooks[event];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  });
}

async function parseHookFile(
  basePath: string,
  sourcePath: string,
  agent: HookAgent,
  name: string
): Promise<DiscoveredHookBundle | null> {
  const fullPath = join(basePath, sourcePath);
  let data: Record<string, unknown>;
  try {
    data = await readJsonStrict(fullPath);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    p.log.warn(
      `Skipping invalid hook JSON at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  if (agent === 'github-copilot' && data.version !== 1) {
    p.log.warn(`Skipping ${sourcePath}: Copilot hook files must declare version: 1.`);
    return null;
  }
  if (!isObject(data.hooks)) {
    p.log.warn(`Skipping ${sourcePath}: expected a top-level hooks object.`);
    return null;
  }

  const events = eventsFromHooks(data.hooks);
  if (events.length === 0) return null;
  return { name, agent, sourcePath, events, hooks: data.hooks };
}

async function detectInlineCodexHooks(basePath: string, sourcePath: string): Promise<void> {
  const content = await readFile(join(basePath, sourcePath), 'utf-8').catch(() => '');
  if (/^\s*\[\[hooks\./m.test(content) || /^\s*\[\[hooks\]\]/m.test(content)) {
    p.log.warn(
      `Codex inline TOML hooks detected at ${sourcePath} but not installable in V1; publish .codex/hooks.json.`
    );
  }
}

export async function discoverHooks(basePath: string): Promise<DiscoveredHookBundle[]> {
  const discovered: DiscoveredHookBundle[] = [];
  const candidates = await scanRepoForPathMatches(basePath, ({ relPath }) => {
    if (repoPathMatchesSuffix(relPath, '.codex/hooks.json')) return true;
    if (repoPathMatchesSuffix(relPath, '.codex/config.toml')) return true;
    if (repoPathMatchesSuffix(relPath, '.claude/settings.json')) return true;
    return /(^|\/)\.github\/hooks\/[^/]+\.json$/.test(relPath);
  });

  for (const path of candidates) {
    const sourcePath = normalizeRel(relative(basePath, path));
    if (repoPathMatchesSuffix(sourcePath, '.codex/config.toml')) {
      await detectInlineCodexHooks(basePath, sourcePath);
      continue;
    }

    if (repoPathMatchesSuffix(sourcePath, '.codex/hooks.json')) {
      const codex = await parseHookFile(basePath, sourcePath, 'codex', 'codex-hooks');
      if (codex) discovered.push(codex);
      continue;
    }

    if (repoPathMatchesSuffix(sourcePath, '.claude/settings.json')) {
      const claude = await parseHookFile(basePath, sourcePath, 'claude-code', 'claude-hooks');
      if (claude) discovered.push(claude);
      continue;
    }

    if (/(^|\/)\.github\/hooks\/[^/]+\.json$/.test(sourcePath)) {
      const rawName = basename(sourcePath, '.json');
      const bundle = await parseHookFile(
        basePath,
        sourcePath,
        'github-copilot',
        `copilot-${rawName}`
      );
      if (bundle) discovered.push(bundle);
    }
  }

  const seen = new Map<string, number>();
  return discovered.map((bundle) => {
    const key = `${bundle.agent}:${bundle.name.toLowerCase()}`;
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0
      ? bundle
      : { ...bundle, name: `${bundle.name}-${shortHash(bundle.sourcePath)}` };
  });
}

function hookTargetPath(bundle: DiscoveredHookBundle, cwd = process.cwd()): string {
  if (bundle.agent === 'codex') return join(cwd, '.codex', 'hooks.json');
  if (bundle.agent === 'claude-code') return join(cwd, '.claude', 'settings.json');
  return join(cwd, '.github', 'hooks', `sloprider-${bundle.name}.json`);
}

function hookAssetDirs(bundle: DiscoveredHookBundle): Array<{ source: string; target: string }> {
  const bundleDir = normalizeRel(dirname(bundle.sourcePath));
  if (bundle.agent === 'codex') {
    return [{ source: normalizeRel(join(bundleDir, 'hooks')), target: '.codex/hooks' }];
  }
  if (bundle.agent === 'claude-code') {
    return [{ source: normalizeRel(join(bundleDir, 'hooks')), target: '.claude/hooks' }];
  }
  return [];
}

function removeLockedHooks(
  targetHooks: Record<string, unknown>,
  lockedHooks: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...targetHooks };
  for (const [event, lockedValue] of Object.entries(lockedHooks)) {
    const current = next[event];
    if (Array.isArray(current) && Array.isArray(lockedValue)) {
      const lockedSet = new Set(lockedValue.map(stableJson));
      const kept = current.filter((entry) => !lockedSet.has(stableJson(entry)));
      if (kept.length > 0) next[event] = kept;
      else delete next[event];
    } else if (stableJson(current) === stableJson(lockedValue)) {
      delete next[event];
    }
  }
  return next;
}

function appendHooks(
  targetHooks: Record<string, unknown>,
  sourceHooks: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...targetHooks };
  for (const [event, value] of Object.entries(sourceHooks)) {
    if (Array.isArray(value)) {
      const current = Array.isArray(next[event]) ? (next[event] as unknown[]) : [];
      next[event] = [...current, ...value];
    } else {
      next[event] = value;
    }
  }
  return next;
}

function enableCodexHooksToml(content: string): string {
  const lines = content.split(/\r?\n/);
  let featuresStart = -1;
  let featuresEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[features\]\s*$/.test(lines[i]!)) {
      featuresStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\[/.test(lines[j]!)) {
          featuresEnd = j;
          break;
        }
      }
      break;
    }
  }
  if (featuresStart === -1) {
    const trimmed = content.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}[features]\ncodex_hooks = true\n`;
  }

  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (/^\s*codex_hooks\s*=/.test(lines[i]!)) {
      lines[i] = 'codex_hooks = true';
      return lines.join('\n').replace(/\s+$/, '\n');
    }
  }
  lines.splice(featuresEnd, 0, 'codex_hooks = true');
  return lines.join('\n').replace(/\s+$/, '\n');
}

async function enableCodexHooks(cwd: string): Promise<void> {
  const path = join(cwd, '.codex', 'config.toml');
  const content = await readFile(path, 'utf-8').catch(() => '');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, enableCodexHooksToml(content), 'utf-8');
}

async function collectFiles(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return [];
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await walk(root);
  return files.sort();
}

async function removeCopiedFiles(
  entry: HookLockEntry,
  cwd: string,
  failOnEdited: boolean
): Promise<void> {
  for (const [relPath, hash] of Object.entries(entry.copiedFiles)) {
    const target = join(cwd, relPath);
    if (!(await pathExists(target))) continue;
    const currentHash = await sha256File(target);
    if (currentHash !== hash) {
      if (failOnEdited) throw new Error(`Managed hook file was edited: ${relPath}`);
      continue;
    }
    await rm(target, { force: true });
  }
}

async function copyAssets(
  sourceRoot: string,
  bundle: DiscoveredHookBundle,
  previous: HookLockEntry | undefined,
  cwd: string
): Promise<Record<string, string>> {
  const copied: Record<string, string> = {};
  for (const dir of hookAssetDirs(bundle)) {
    const fromDir = join(sourceRoot, dir.source);
    for (const sourceFile of await collectFiles(fromDir)) {
      const relWithinDir = normalizeRel(relative(fromDir, sourceFile));
      const targetRel = normalizeRel(join(dir.target, relWithinDir));
      const targetFile = join(cwd, targetRel);
      if (await pathExists(targetFile)) {
        const currentHash = await sha256File(targetFile);
        const ownedHash = previous?.copiedFiles[targetRel];
        if (!ownedHash || ownedHash !== currentHash) {
          throw new Error(`Hook asset conflict at ${targetRel}`);
        }
      }
      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, await readFile(sourceFile));
      copied[targetRel] = await sha256File(targetFile);
    }
  }
  return copied;
}

async function installCodex(
  sourceRoot: string,
  bundle: DiscoveredHookBundle,
  previous: HookLockEntry | undefined,
  cwd: string
): Promise<{ targetPath: string; copiedFiles: Record<string, string> }> {
  const targetPath = hookTargetPath(bundle, cwd);
  const data = await readJsonOrDefault(targetPath, { hooks: {} });
  const existingHooks = isObject(data.hooks) ? data.hooks : {};
  data.hooks = appendHooks(
    previous ? removeLockedHooks(existingHooks, previous.hooks) : existingHooks,
    bundle.hooks
  );
  await writeJson(targetPath, data);
  await enableCodexHooks(cwd);
  const copiedFiles = await copyAssets(sourceRoot, bundle, previous, cwd);
  return { targetPath, copiedFiles };
}

async function installClaude(
  sourceRoot: string,
  bundle: DiscoveredHookBundle,
  previous: HookLockEntry | undefined,
  cwd: string
): Promise<{ targetPath: string; copiedFiles: Record<string, string> }> {
  const targetPath = hookTargetPath(bundle, cwd);
  const data = await readJsonOrDefault(targetPath, {});
  const existingHooks = isObject(data.hooks) ? data.hooks : {};
  data.hooks = appendHooks(
    previous ? removeLockedHooks(existingHooks, previous.hooks) : existingHooks,
    bundle.hooks
  );
  await writeJson(targetPath, data);
  if (data.disableAllHooks === true) {
    p.log.warn(
      'Claude disableAllHooks is true; installed hooks will not run until that setting changes.'
    );
  }
  const copiedFiles = await copyAssets(sourceRoot, bundle, previous, cwd);
  return { targetPath, copiedFiles };
}

async function installCopilot(
  sourceRoot: string,
  bundle: DiscoveredHookBundle,
  previous: HookLockEntry | undefined,
  cwd: string
): Promise<{ targetPath: string; copiedFiles: Record<string, string> }> {
  const targetPath = hookTargetPath(bundle, cwd);
  const targetRel = normalizeRel(relative(cwd, targetPath));
  if (await pathExists(targetPath)) {
    const currentHash = await sha256File(targetPath);
    const ownedHash = previous?.copiedFiles[targetRel];
    if (!ownedHash || ownedHash !== currentHash) {
      throw new Error(`Hook file conflict at ${targetRel}`);
    }
  }
  const source = await readJsonStrict(join(sourceRoot, bundle.sourcePath));
  await mkdir(dirname(targetPath), { recursive: true });
  await writeJson(targetPath, source);
  return { targetPath, copiedFiles: { [targetRel]: await sha256File(targetPath) } };
}

export async function installHookBundle(
  sourceRoot: string,
  bundle: DiscoveredHookBundle,
  parsed: ParsedSource,
  source: string,
  cwd = process.cwd()
): Promise<InstallResult> {
  const lock = await readHookLock(cwd);
  const previous = lock.hooks[bundle.name];
  try {
    if (previous) await removeCopiedFiles(previous, cwd, true);
    const result =
      bundle.agent === 'codex'
        ? await installCodex(sourceRoot, bundle, previous, cwd)
        : bundle.agent === 'claude-code'
          ? await installClaude(sourceRoot, bundle, previous, cwd)
          : await installCopilot(sourceRoot, bundle, previous, cwd);

    await addHookToLock(
      bundle.name,
      {
        name: bundle.name,
        agent: bundle.agent,
        source,
        sourceType: parsed.type as 'github' | 'gitlab' | 'git',
        ref: parsed.ref,
        sourcePath: bundle.sourcePath,
        targetPath: normalizeRel(relative(cwd, result.targetPath)),
        events: bundle.events,
        hooks: bundle.hooks,
        copiedFiles: result.copiedFiles,
      },
      cwd
    );
    return { success: true, name: bundle.name, agent: bundle.agent };
  } catch (error) {
    return {
      success: false,
      name: bundle.name,
      agent: bundle.agent,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeHookBundle(name: string, cwd = process.cwd()): Promise<boolean> {
  const lock = await readHookLock(cwd);
  const entry = lock.hooks[name];
  if (!entry) {
    p.log.warn(`No managed hook named ${name}.`);
    return false;
  }

  if (entry.agent === 'github-copilot') {
    const path = join(cwd, entry.targetPath);
    if (existsSync(path)) await rm(path, { force: true });
  } else {
    const path = join(cwd, entry.targetPath);
    const data = await readJsonOrDefault(path, entry.agent === 'codex' ? { hooks: {} } : {});
    const existingHooks = isObject(data.hooks) ? data.hooks : {};
    const nextHooks = removeLockedHooks(existingHooks, entry.hooks);
    data.hooks = nextHooks;
    if (Object.keys(nextHooks).length === 0) delete data.hooks;
    await writeJson(path, data);
    await removeCopiedFiles(entry, cwd, false);
  }

  await removeHookFromLock(name, cwd);
  return true;
}

export async function listInstalledHooks(cwd = process.cwd()): Promise<InstalledHookBundle[]> {
  const lock = await readHookLock(cwd);
  return Object.values(lock.hooks).map((entry) => ({
    name: entry.name,
    agent: entry.agent,
    scope: 'project',
    events: entry.events,
    targetPath: entry.targetPath,
    sourcePath: entry.sourcePath,
  }));
}

export function formatHookAgent(agent: HookAgent): string {
  return agents[agent].displayName;
}
