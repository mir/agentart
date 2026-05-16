import type { AgentType } from './core/agents.ts';
type AgentResult =
  | {
      isAgent: true;
      agent: { name: string };
    }
  | {
      isAgent: false;
      agent: undefined;
    };
let cachedResult: AgentResult | null = null;
const agentNameToType: Record<string, AgentType> = {
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  claude: 'claude-code',
  cowork: 'claude-code',
  gemini: 'gemini-cli',
  codex: 'codex',
  opencode: 'opencode',
  'github-copilot': 'github-copilot',
};
async function determineAgent(): Promise<AgentResult> {
  const aiAgent = process.env.AI_AGENT?.trim();
  if (aiAgent) {
    return {
      isAgent: true,
      agent: { name: aiAgent === 'github-copilot-cli' ? 'github-copilot' : aiAgent },
    };
  }
  if (process.env.CURSOR_TRACE_ID) return { isAgent: true, agent: { name: 'cursor' } };
  if (process.env.CURSOR_AGENT || process.env.CURSOR_EXTENSION_HOST_ROLE === 'agent-exec') {
    return { isAgent: true, agent: { name: 'cursor-cli' } };
  }
  if (process.env.GEMINI_CLI) return { isAgent: true, agent: { name: 'gemini' } };
  if (process.env.CODEX_SANDBOX || process.env.CODEX_CI || process.env.CODEX_THREAD_ID) {
    return { isAgent: true, agent: { name: 'codex' } };
  }
  if (process.env.OPENCODE_CLIENT) return { isAgent: true, agent: { name: 'opencode' } };
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) {
    return {
      isAgent: true,
      agent: { name: process.env.CLAUDE_CODE_IS_COWORK ? 'cowork' : 'claude' },
    };
  }
  if (
    process.env.COPILOT_MODEL ||
    process.env.COPILOT_ALLOW_ALL ||
    process.env.COPILOT_GITHUB_TOKEN
  ) {
    return { isAgent: true, agent: { name: 'github-copilot' } };
  }
  return { isAgent: false, agent: undefined };
}
export async function detectAgent(): Promise<AgentResult> {
  if (cachedResult) return cachedResult;
  cachedResult = await determineAgent();
  return cachedResult;
}
export async function isRunningInAgent(): Promise<boolean> {
  const result = await detectAgent();
  return result.isAgent;
}
export async function getAgentName(): Promise<string | null> {
  const result = await detectAgent();
  return result.isAgent && result.agent ? result.agent.name : null;
}
export function getAgentType(agentName: string): AgentType | null {
  return agentNameToType[agentName] ?? null;
}
