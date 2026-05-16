import type { AgentType } from '../core/agents.ts';
export type McpTransport = 'stdio' | 'http' | 'sse';
export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}
export interface McpInstallResult {
  success: boolean;
  agent: AgentType;
  path: string;
  error?: string;
}
