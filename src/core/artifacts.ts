import type { AgentType } from './agents.ts';
import type { McpCatalogItem } from '../artifacts/mcp.ts';
import type { HookBundleCatalogItem } from '../artifacts/hooks.ts';
export type ArtifactKind = 'skill' | 'mcp-server' | 'hook-bundle' | 'plugin';
export interface Skill {
  name: string;
  description: string;
  path: string;
  rawContent?: string;
  pluginName?: string;
  metadata?: Record<string, unknown>;
}
export type PluginLocator =
  | { source: 'local'; path: string }
  | { source: 'git-subdir'; url: string; path: string; ref?: string };
export interface PluginCatalogItem {
  name: string;
  version?: string;
  description?: string;
  category?: string;
  configPath: string;
  manifestPath?: string;
  marketplaceName?: string;
  marketplacePath?: string;
  source: PluginLocator;
}
export type CatalogItem =
  | { type: 'skill'; skill: Skill }
  | { type: 'mcp'; server: McpCatalogItem }
  | { type: 'hook'; hook: HookBundleCatalogItem }
  | { type: 'plugin'; plugin: PluginCatalogItem };
export interface InstallPlan {
  items: CatalogItem[];
  scope: 'project' | 'global';
  agents: AgentType[];
}
export interface InstallOutcome {
  installed: CatalogItem[];
}
