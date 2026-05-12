import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli } from './test-utils.ts';

describe('mcp command', () => {
  let testDir: string;

  function testHomeEnv(homeDir: string): Record<string, string> {
    return {
      HOME: homeDir,
      USERPROFILE: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      CODEX_HOME: join(homeDir, '.codex'),
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      XDG_STATE_HOME: join(homeDir, '.local', 'state'),
    };
  }

  function writeProjectAndGlobalClaudeMcps(homeDir: string): void {
    writeFileSync(
      join(testDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'project-mcp': { command: 'node', args: ['server.js'] },
        },
      })
    );

    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'global-mcp': { command: 'npx', args: ['global-server'] },
        },
      })
    );
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'agentart-mcp-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('lists project and global MCP servers by default', () => {
    const homeDir = join(testDir, 'home');
    writeProjectAndGlobalClaudeMcps(homeDir);

    const result = runCli(['mcp', 'ls'], testDir, testHomeEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project MCP Servers');
    expect(result.stdout).toContain('project-mcp');
    expect(result.stdout).toContain('Global MCP Servers');
    expect(result.stdout).toContain('global-mcp');
  });

  it('keeps --global scoped to global MCP servers', () => {
    const homeDir = join(testDir, 'home');
    writeProjectAndGlobalClaudeMcps(homeDir);

    const result = runCli(['mcp', 'ls', '--global'], testDir, testHomeEnv(homeDir));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Global MCP Servers');
    expect(result.stdout).toContain('global-mcp');
    expect(result.stdout).not.toContain('Project MCP Servers');
    expect(result.stdout).not.toContain('project-mcp');
  });

  it('includes project and global MCP scopes in JSON output by default', () => {
    const homeDir = join(testDir, 'home');
    writeProjectAndGlobalClaudeMcps(homeDir);

    const result = runCli(['mcp', 'ls', '--json'], testDir, testHomeEnv(homeDir));

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.map((server: any) => `${server.scope}:${server.name}`).sort()).toEqual([
      'global:global-mcp',
      'project:project-mcp',
    ]);
  });

  it('shows implemented MCP subcommands in help', () => {
    const result = runCli(['mcp', '--help'], testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('install, restore');
    expect(result.stdout).toContain('update, upgrade');
    expect(result.stdout).toContain('lock');
  });
});
