import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseListOptions } from './list.ts';
import { runCli } from './test-utils.ts';

describe('list command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'agentart-list-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('accepts no options', () => {
    expect(parseListOptions([])).toEqual({});
    expect(() => parseListOptions(['--json'])).toThrow('Usage: agentart list');
  });

  it('prints empty state', () => {
    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No skills or MCP servers found');
  });

  it('lists project skills and MCPs by agent', () => {
    const skillDir = join(testDir, '.agents', 'skills', 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: A test skill
---
# Test Skill
`
    );
    writeFileSync(
      join(testDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { context7: { command: 'node', args: ['server.js'] } } })
    );

    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project');
    expect(result.stdout).toContain('Claude Code');
    expect(result.stdout).toContain('test-skill');
    expect(result.stdout).toContain('context7');
  });
});

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
