import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { delimiter, join } from 'path';
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
      join(testDir, 'sloprider-plugins.json'),
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
    expect(result.stderr || result.stdout).toContain('No registered plugin named unmanaged');
  });

  it('removes a Claude-installed plugin after registering installed state', () => {
    const homeDir = join(testDir, 'home');
    const binDir = join(testDir, 'bin');
    const uninstallLog = join(testDir, 'uninstall.log');
    mkdirSync(binDir, { recursive: true });
    writeClaudeShim(
      binDir,
      `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' '[{"id":"context7@claude-plugins-official","version":"unknown","scope":"user","enabled":true,"installPath":"/tmp/context7"}]'
  exit 0
fi
if [ "$1 $2" = "plugin uninstall" ]; then
  printf '%s\\n' "$*" > "${uninstallLog}"
  exit 0
fi
exit 1
`,
      `@echo off
if "%1 %2 %3"=="plugin list --json" (
  echo [{"id":"context7@claude-plugins-official","version":"unknown","scope":"user","enabled":true,"installPath":"/tmp/context7"}]
  exit /b 0
)
if "%1 %2"=="plugin uninstall" (
  echo %*>"${uninstallLog}"
  exit /b 0
)
exit /b 1
`
    );

    const result = runCli(['remove', 'plugin', 'context7@claude-plugins-official'], testDir, {
      ...testHomeEnv(homeDir),
      PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(uninstallLog, 'utf-8')).toContain(
      'plugin uninstall context7@claude-plugins-official --scope user'
    );
    const registry = JSON.parse(
      readFileSync(join(homeDir, '.local', 'state', 'sloprider', '.plugins.json'), 'utf-8')
    );
    expect(registry.plugins['context7@claude-plugins-official']).toBeUndefined();
  });

  it('falls back to the base Claude plugin name when uninstalling a qualified stale entry', () => {
    const homeDir = join(testDir, 'home');
    const binDir = join(testDir, 'bin');
    const uninstallLog = join(testDir, 'uninstall.log');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'hide-secrets@agent-marketplace': {
            name: 'hide-secrets@agent-marketplace',
            agents: ['claude-code'],
            scope: 'project',
            source: 'hide-secrets@agent-marketplace',
            sourceType: 'claude-plugin',
            pluginPath: '/tmp/hide-secrets',
            pluginSource: { source: 'local', path: '/tmp/hide-secrets' },
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );
    writeClaudeShim(
      binDir,
      `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
if [ "$1 $2 $3" = "plugin uninstall hide-secrets@agent-marketplace" ]; then
  echo 'Failed to uninstall plugin "hide-secrets@agent-marketplace": Plugin "hide-secrets@agent-marketplace" not found in installed plugins' >&2
  exit 1
fi
if [ "$1 $2 $3" = "plugin uninstall hide-secrets" ]; then
  printf '%s\\n' "$*" > "${uninstallLog}"
  exit 0
fi
exit 1
`,
      `@echo off
if "%1 %2 %3"=="plugin list --json" (
  echo []
  exit /b 0
)
if "%1 %2 %3"=="plugin uninstall hide-secrets@agent-marketplace" (
  echo Failed to uninstall plugin "hide-secrets@agent-marketplace": Plugin "hide-secrets@agent-marketplace" not found in installed plugins 1>&2
  exit /b 1
)
if "%1 %2 %3"=="plugin uninstall hide-secrets" (
  echo %*>"${uninstallLog}"
  exit /b 0
)
exit /b 1
`
    );

    const result = runCli(['remove', 'plugin', 'hide-secrets@agent-marketplace'], testDir, {
      ...testHomeEnv(homeDir),
      PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(uninstallLog, 'utf-8')).toContain(
      'plugin uninstall hide-secrets --scope project'
    );
  });

  it('ignores Claude uninstall not-found errors for stale registry entries', () => {
    const homeDir = join(testDir, 'home');
    const binDir = join(testDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'hide-secrets@agent-marketplace': {
            name: 'hide-secrets@agent-marketplace',
            agents: ['claude-code'],
            scope: 'project',
            source: 'hide-secrets@agent-marketplace',
            sourceType: 'claude-plugin',
            pluginPath: '/tmp/hide-secrets',
            pluginSource: { source: 'local', path: '/tmp/hide-secrets' },
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );
    writeClaudeShim(
      binDir,
      `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
if [ "$1 $2" = "plugin uninstall" ]; then
  echo "Plugin \\"$3\\" not found in installed plugins" >&2
  exit 1
fi
exit 1
`,
      `@echo off
if "%1 %2 %3"=="plugin list --json" (
  echo []
  exit /b 0
)
if "%1 %2"=="plugin uninstall" (
  echo Plugin "%3" not found in installed plugins 1>&2
  exit /b 1
)
exit /b 1
`
    );

    const result = runCli(['remove', 'plugin', 'hide-secrets@agent-marketplace'], testDir, {
      ...testHomeEnv(homeDir),
      PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    });

    expect(result.exitCode).toBe(0);
    const registry = JSON.parse(readFileSync(join(testDir, 'sloprider-plugins.json'), 'utf-8'));
    expect(registry.plugins['hide-secrets@agent-marketplace']).toBeUndefined();
  });

  it('rejects legacy remove shape', () => {
    const result = runCli(['remove', 'test-skill'], testDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('Usage: sloprider remove skill <name>');
  });
});

function writeClaudeShim(binDir: string, shellScript: string, cmdScript: string): void {
  writeFileSync(join(binDir, 'claude'), shellScript);
  chmodSync(join(binDir, 'claude'), 0o755);
  writeFileSync(join(binDir, 'claude.cmd'), cmdScript.replace(/\n/g, '\r\n'));
}

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
