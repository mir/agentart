import { lstat, rm } from 'fs/promises';
import * as p from '@clack/prompts';
import pc from './colors.ts';
import { agents } from './agents.ts';
import { getMcpCapableAgents } from './mcp-agents.ts';
import { removeMcpServerForAgent } from './mcp-config.ts';
import { removeMcpFromLock } from './mcp-lock.ts';
import { removeHookBundle } from './hooks.ts';
import { getCanonicalPath, getInstallPath } from './installer.ts';
import { removeSkillFromLocalLock } from './local-lock.ts';
import { removeSkillFromLock } from './skill-lock.ts';
import { removeCodexMarketplaceEntry } from './plugin-marketplace.ts';
import { readPluginRegistry, removePluginFromRegistry } from './plugin-registry.ts';
import { getPluginCapableAgents, removePluginForAgent } from './plugin-agents.ts';
import { collectInstalledArtifacts, type Scope } from './list.ts';
import type { AgentType } from './types.ts';

export type RemoveTarget =
  | { type: 'skill'; name: string; scope?: Scope; agents?: AgentType[] }
  | { type: 'mcp'; name: string; scope?: Scope; agents?: AgentType[] }
  | { type: 'hook'; name: string; scope?: 'project'; agents?: AgentType[] }
  | { type: 'plugin'; name: string; scope?: Scope; agents?: AgentType[]; force?: boolean };

const scopes: Scope[] = ['project', 'global'];

async function removePath(path: string): Promise<boolean> {
  const exists = await lstat(path).catch(() => null);
  if (!exists) return false;
  await rm(path, { recursive: true, force: true });
  return true;
}

async function removeSkill(name: string, scope: Scope, targetAgents: AgentType[]): Promise<number> {
  const global = scope === 'global';
  const paths = new Set<string>([getCanonicalPath(name, { global })]);
  for (const agent of targetAgents) {
    paths.add(getInstallPath(name, agent, { global }));
  }

  const removed = await Promise.all([...paths].map(removePath));
  if (global) {
    await removeSkillFromLock(name);
  } else {
    await removeSkillFromLocalLock(name);
  }
  return removed.filter(Boolean).length;
}

async function removeMcp(name: string, scope: Scope, targetAgents: AgentType[]): Promise<number> {
  const global = scope === 'global';
  const results = await Promise.all(
    targetAgents.map((agent) => removeMcpServerForAgent(name, agent, { global }))
  );
  await removeMcpFromLock(name, { global });
  return results.filter((result) => result.success && result.removed).length;
}

async function removePlugin(
  name: string,
  scope: Scope,
  requestedAgents: AgentType[] | undefined,
  force = false
): Promise<number> {
  const global = scope === 'global';
  const entry = await removePluginFromRegistry(name, { global });
  if (!entry && !force) return 0;

  const agentsToRemove = requestedAgents ?? entry?.agents ?? getPluginCapableAgents();
  let removed = 0;
  if (agentsToRemove.includes('codex') && (await removeCodexMarketplaceEntry(name, scope))) {
    removed++;
  }
  for (const agent of agentsToRemove) {
    if (agent === 'claude-code' && (await removePluginForAgent(name, 'claude-code', scope))) {
      removed++;
    }
  }
  return removed;
}

export async function removeTargets(targets: RemoveTarget[]): Promise<void> {
  let removed = 0;
  for (const target of targets) {
    const targetScopes = target.scope ? [target.scope] : scopes;
    for (const scope of targetScopes) {
      if (target.type === 'skill') {
        removed += await removeSkill(
          target.name,
          scope,
          target.agents ?? (Object.keys(agents) as AgentType[])
        );
      } else if (target.type === 'mcp') {
        removed += await removeMcp(
          target.name,
          scope,
          target.agents ?? getMcpCapableAgents({ global: scope === 'global' })
        );
      } else if (target.type === 'plugin') {
        removed += await removePlugin(target.name, scope, target.agents, target.force);
      } else if (scope === 'project') {
        removed += (await removeHookBundle(target.name)) ? 1 : 0;
      }
    }
  }

  if (removed === 0) {
    p.log.warn('Nothing matched.');
  } else {
    p.log.success(`Removed ${removed} installed item(s).`);
  }
}

export async function runRemove(args: string[]): Promise<void> {
  const [type, name, ...rest] = args;
  const force = rest.includes('--force');
  if (
    (type !== 'skill' && type !== 'mcp' && type !== 'hook' && type !== 'plugin') ||
    !name ||
    rest.some((arg) => arg !== '--force')
  ) {
    throw new Error(
      'Usage: sloprider remove skill <name>\n       sloprider remove mcp <name>\n       sloprider remove hook <name>\n       sloprider remove plugin <name> [--force]'
    );
  }

  if (type === 'plugin' && !force) {
    await collectInstalledArtifacts();
    const [projectRegistry, globalRegistry] = await Promise.all([
      readPluginRegistry({ global: false }),
      readPluginRegistry({ global: true }),
    ]);
    if (!projectRegistry.plugins[name] && !globalRegistry.plugins[name]) {
      throw new Error(`No registered plugin named ${name}. Use --force to remove anyway.`);
    }
  }

  await removeTargets([{ type, name, force } as RemoveTarget]);
  p.outro(pc.green('Done!'));
}
