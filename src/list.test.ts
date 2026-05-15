import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseListOptions } from './list.ts';
import { runCli } from './test-utils.ts';

describe('list command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-list-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('accepts no options', () => {
    expect(parseListOptions([])).toEqual({});
    expect(() => parseListOptions(['--json'])).toThrow('Usage: sloprider list');
  });

  it('prints empty state', () => {
    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No skills, MCP servers, hooks, or plugins found');
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

  it('lists Claude Code project MCPs stored in ~/.claude.json', () => {
    const homeDir = join(testDir, 'home');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        projects: {
          [realpathSync(testDir)]: {
            mcpServers: {
              datachat: {
                type: 'http',
                url: 'http://127.0.0.1:8081/mcp/',
              },
            },
            disabledMcpServers: ['datachat'],
          },
        },
      })
    );

    const result = runCli(['list'], testDir, testHomeEnv(homeDir));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project');
    expect(result.stdout).toContain('Claude Code');
    expect(result.stdout).toContain('datachat');
    expect(result.stdout).toContain('http://127.0.0.1:8081/mcp/');
    expect(result.stdout).toContain('(disabled)');
  });

  it('lists managed project hooks', () => {
    writeFileSync(
      join(testDir, 'sloprider-hook-lock.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          'codex-hooks': {
            name: 'codex-hooks',
            agent: 'codex',
            source: 'owner/repo',
            sourceType: 'github',
            sourcePath: '.codex/hooks.json',
            targetPath: '.codex/hooks.json',
            events: ['SessionStart', 'Stop'],
            hooks: {},
            copiedFiles: {},
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );

    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project');
    expect(result.stdout).toContain('Codex');
    expect(result.stdout).toContain('Hooks');
    expect(result.stdout).toContain('codex-hooks');
    expect(result.stdout).toContain('SessionStart, Stop');
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
