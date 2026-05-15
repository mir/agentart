export type AgentType =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'gemini-cli'
  | 'github-copilot'
  | 'opencode'
  | 'pi';

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** Raw SKILL.md content for hashing */
  rawContent?: string;
  /** Name of the plugin this skill belongs to (if any) */
  pluginName?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentConfig {
  name: string;
  displayName: string;
  skillsDir: string;
  /** Global skills directory. Set to undefined if the agent doesn't support global installation. */
  globalSkillsDir: string | undefined;
  detectInstalled: () => Promise<boolean>;
}

export interface ParsedSource {
  type: 'github' | 'gitlab' | 'git' | 'local';
  url: string;
  subpath?: string;
  localPath?: string;
  ref?: string;
  /** Skill name extracted from @skill syntax (e.g., owner/repo@skill-name) */
  skillFilter?: string;
}

export type PluginSourceDescriptor =
  | { source: 'local'; path: string }
  | { source: 'git-subdir'; url: string; path: string; ref?: string };

export interface DiscoveredPlugin {
  name: string;
  version?: string;
  description?: string;
  category?: string;
  sourcePath: string;
  manifestPath?: string;
  marketplaceName?: string;
  marketplacePath?: string;
  source: PluginSourceDescriptor;
}
