import { homedir } from 'os';
import { join } from 'path';
import type { AgentType } from '../core/agents.ts';
const home = homedir();
const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
const codexHome = process.env.CODEX_HOME?.trim() || join(home, '.codex');
const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
export type McpConfigFormat = 'mcpServersJson' | 'vscodeJson' | 'codexToml' | 'opencodeJson';
export interface AgentMcpConfig {
  agent: AgentType;
  displayName: string;
  projectPath?: string;
  globalPath?: string;
  format: McpConfigFormat;
}
export const mcpAgents: Partial<Record<AgentType, AgentMcpConfig>> = {
  'claude-code': {
    agent: 'claude-code',
    displayName: 'Claude Code',
    projectPath: '.mcp.json',
    globalPath: join(claudeHome, 'mcp.json'),
    format: 'mcpServersJson',
  },
  codex: {
    agent: 'codex',
    displayName: 'Codex',
    projectPath: '.codex/config.toml',
    globalPath: join(codexHome, 'config.toml'),
    format: 'codexToml',
  },
  cursor: {
    agent: 'cursor',
    displayName: 'Cursor',
    projectPath: '.cursor/mcp.json',
    globalPath: join(home, '.cursor/mcp.json'),
    format: 'mcpServersJson',
  },
  'gemini-cli': {
    agent: 'gemini-cli',
    displayName: 'Gemini CLI',
    projectPath: '.gemini/settings.json',
    globalPath: join(home, '.gemini/settings.json'),
    format: 'mcpServersJson',
  },
  'github-copilot': {
    agent: 'github-copilot',
    displayName: 'GitHub Copilot / VS Code',
    projectPath: '.vscode/mcp.json',
    globalPath: join(configHome, 'Code/User/mcp.json'),
    format: 'vscodeJson',
  },
  opencode: {
    agent: 'opencode',
    displayName: 'OpenCode',
    projectPath: 'opencode.json',
    globalPath: join(configHome, 'opencode/opencode.json'),
    format: 'opencodeJson',
  },
};
export function getMcpAgentConfig(agent: AgentType): AgentMcpConfig | undefined {
  return mcpAgents[agent];
}
export function getMcpCapableAgents(options: { global?: boolean } = {}): AgentType[] {
  return (Object.entries(mcpAgents) as [AgentType, AgentMcpConfig][])
    .filter(([_, config]) =>
      options.global ? Boolean(config.globalPath) : Boolean(config.projectPath)
    )
    .map(([agent]) => agent);
}
export function getMcpConfigPath(
  agent: AgentType,
  options: { global?: boolean; cwd?: string } = {}
): string | null {
  const config = getMcpAgentConfig(agent);
  if (!config) return null;
  if (options.global) return config.globalPath ?? null;
  if (!config.projectPath) return null;
  return join(options.cwd || process.cwd(), config.projectPath);
}
