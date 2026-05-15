import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli } from './test-utils.ts';

describe('remove command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-remove-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('removes a skill by type and name', () => {
    const skillDir = join(testDir, '.agents', 'skills', 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: Test skill
---
# Test Skill
`
    );

    const result = runCli(['remove', 'skill', 'test-skill'], testDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(skillDir)).toBe(false);
  });

  it('removes an MCP server by type and name', () => {
    const configPath = join(testDir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { context7: { command: 'node', args: ['server.js'] } } })
    );

    const result = runCli(['remove', 'mcp', 'context7'], testDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).not.toContain('context7');
  });

  it('removes a Claude Code project MCP from ~/.claude.json', () => {
    const homeDir = join(testDir, 'home');
    mkdirSync(homeDir, { recursive: true });
    const claudeStatePath = join(homeDir, '.claude.json');
    writeFileSync(
      claudeStatePath,
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

    const result = runCli(['remove', 'mcp', 'datachat'], testDir, testHomeEnv(homeDir));
    expect(result.exitCode).toBe(0);

    const state = JSON.parse(readFileSync(claudeStatePath, 'utf-8'));
    expect(state.projects[realpathSync(testDir)].mcpServers.datachat).toBeUndefined();
    expect(state.projects[realpathSync(testDir)].disabledMcpServers).toEqual([]);
  });

  it('removes a managed hook by type and name', () => {
    const configPath = join(testDir, '.codex', 'hooks.json');
    mkdirSync(join(testDir, '.codex'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        hooks: {
          Stop: [{ command: 'manual' }, { command: 'managed' }],
        },
      })
    );
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
            events: ['Stop'],
            hooks: { Stop: [{ command: 'managed' }] },
            copiedFiles: {},
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );

    const result = runCli(['remove', 'hook', 'codex-hooks'], testDir);
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.hooks.Stop).toEqual([{ command: 'manual' }]);
  });

  it('removes a managed Codex plugin by type and name', () => {
    const marketplacePath = join(testDir, '.agents', 'plugins', 'marketplace.json');
    mkdirSync(join(testDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      marketplacePath,
      JSON.stringify({
        plugins: [
          {
            name: 'manual-plugin',
            source: { source: 'local', path: './manual' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Other',
          },
          {
            name: 'managed-plugin',
            source: { source: 'local', path: './plugins/managed-plugin' },
            policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      })
    );
    writeFileSync(
      join(testDir, 'sloprider-plugin-lock.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'managed-plugin': {
            name: 'managed-plugin',
            agents: ['codex'],
            scope: 'project',
            source: 'owner/repo',
            sourceType: 'github',
            pluginPath: 'plugins/managed-plugin',
            targetPath: 'plugins/managed-plugin',
            pluginSource: { source: 'local', path: './plugins/managed-plugin' },
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );

    const result = runCli(['remove', 'plugin', 'managed-plugin'], testDir);
    expect(result.exitCode).toBe(0);
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'));
    expect(marketplace.plugins.map((plugin: any) => plugin.name)).toEqual(['manual-plugin']);
  });

  it('rejects removing an unmanaged plugin without force', () => {
    const result = runCli(['remove', 'plugin', 'unmanaged'], testDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('No sloprider-managed plugin named unmanaged');
  });

  it('rejects legacy remove shape', () => {
    const result = runCli(['remove', 'test-skill'], testDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('Usage: sloprider remove skill <name>');
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
