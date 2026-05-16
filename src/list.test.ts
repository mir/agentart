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
import { parseListOptions } from './commands/list.ts';
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
            configPath: '.codex/hooks.json',
            installedPath: '.codex/hooks.json',
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

  it('lists Claude Code plugins installed through Claude', () => {
    const homeDir = join(testDir, 'home');
    const badBinDir = join(testDir, 'bad-bin');
    const binDir = join(testDir, 'bin');
    mkdirSync(badBinDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeClaudeShim(
      badBinDir,
      `#!/bin/sh
echo "error: unknown command 'list'" >&2
exit 1
`,
      `@echo off
echo error: unknown command 'list' 1>&2
exit /b 1
`
    );
    writeClaudeShim(
      binDir,
      `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then
  printf '%s\\n' '[{"id":"context7@claude-plugins-official","version":"unknown","scope":"user","enabled":true,"installPath":"/tmp/context7"},{"id":"project-plugin@demo","version":"1.0.0","scope":"project","enabled":true,"installPath":"/tmp/project-plugin"}]'
  exit 0
fi
exit 1
`,
      `@echo off
if "%1 %2 %3"=="plugin list --json" (
  echo [{"id":"context7@claude-plugins-official","version":"unknown","scope":"user","enabled":true,"installPath":"/tmp/context7"},{"id":"project-plugin@demo","version":"1.0.0","scope":"project","enabled":true,"installPath":"/tmp/project-plugin"}]
  exit /b 0
)
exit /b 1
`
    );

    const result = runCli(['list'], testDir, {
      ...testHomeEnv(homeDir),
      PATH: [badBinDir, binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Project');
    expect(result.stdout).toContain('Global');
    expect(result.stdout).toContain('Claude Code');
    expect(result.stdout).toContain('Plugins');
    expect(result.stdout).toContain('context7@claude-plugins-official');
    expect(result.stdout).toContain('/tmp/context7');
    expect(result.stdout).toContain('project-plugin@demo');
    expect(result.stdout).toContain('/tmp/project-plugin');

    const globalRegistry = JSON.parse(
      readFileSync(join(homeDir, '.local', 'state', 'sloprider', '.plugins.json'), 'utf-8')
    );
    expect(globalRegistry.plugins['context7@claude-plugins-official']).toMatchObject({
      name: 'context7@claude-plugins-official',
      agents: ['claude-code'],
      scope: 'global',
      sourceType: 'claude-plugin',
      rootPath: '/tmp/context7',
    });

    const projectRegistry = JSON.parse(
      readFileSync(join(testDir, 'sloprider-plugins.json'), 'utf-8')
    );
    expect(projectRegistry.plugins['project-plugin@demo']).toMatchObject({
      name: 'project-plugin@demo',
      agents: ['claude-code'],
      scope: 'project',
      sourceType: 'claude-plugin',
      rootPath: '/tmp/project-plugin',
    });
  });

  it('does not duplicate Claude marketplace plugins already managed by sloprider', () => {
    const homeDir = join(testDir, 'home');
    const binDir = join(testDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'hide-secrets': {
            name: 'hide-secrets',
            agents: ['claude-code'],
            scope: 'project',
            source: 'owner/repo',
            sourceType: 'github',
            rootPath: 'plugins/redactor',
            marketplaceName: 'agent-marketplace',
            marketplacePath: '.claude-plugin/marketplace.json',
            installedPath: 'plugins/redactor',
            locator: {
              source: 'git-subdir',
              url: 'https://example.com/repo.git',
              path: './plugins/redactor',
            },
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
  printf '%s\\n' '[{"id":"hide-secrets@agent-marketplace","version":"1.0.0","scope":"project","enabled":true,"installPath":"/tmp/hide-secrets"}]'
  exit 0
fi
exit 1
`,
      `@echo off
if "%1 %2 %3"=="plugin list --json" (
  echo [{"id":"hide-secrets@agent-marketplace","version":"1.0.0","scope":"project","enabled":true,"installPath":"/tmp/hide-secrets"}]
  exit /b 0
)
exit /b 1
`
    );

    const result = runCli(['list'], testDir, {
      ...testHomeEnv(homeDir),
      PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hide-secrets');
    expect(result.stdout).not.toContain('hide-secrets@agent-marketplace');
    expect(result.stdout.match(/hide-secrets/g)).toHaveLength(1);
  });

  it('ignores stale plugin registry entries without current-schema fields', () => {
    const homeDir = join(testDir, 'home');
    mkdirSync(join(homeDir, '.local', 'state', 'sloprider'), { recursive: true });
    writeFileSync(
      join(homeDir, '.local', 'state', 'sloprider', '.plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'stale-plugin': {
            name: 'stale-plugin',
            agents: ['claude-code'],
            scope: 'global',
            source: 'owner/repo',
            sourceType: 'github',
            pluginPath: 'plugins/stale-plugin',
            targetPath: '/tmp/stale-plugin',
            pluginSource: 'owner/repo',
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );

    const result = runCli(['list'], testDir, testHomeEnv(homeDir));
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('No skills, MCP servers, hooks, or plugins found');
    expect(stdout).not.toContain('stale-plugin');
  });

  it('renders valid current Claude plugin registry entries under plugins', () => {
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'valid-plugin': {
            name: 'valid-plugin',
            agents: ['claude-code'],
            scope: 'project',
            source: 'owner/repo',
            sourceType: 'github',
            rootPath: 'plugins/valid-plugin',
            installedPath: 'plugins/valid-plugin',
            locator: {
              source: 'git-subdir',
              url: 'https://example.com/repo.git',
              path: 'plugins/valid-plugin',
            },
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );

    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Project');
    expect(stdout).toContain('Claude Code');
    expect(stdout).toContain('Plugins');
    expect(stdout).toContain('valid-plugin');
    expect(stdout).toContain('plugins/valid-plugin');
  });

  it('renders Codex marketplace entries separately from plugins', () => {
    mkdirSync(join(testDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(testDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            name: 'agent-marketplace',
            source: {
              source: 'git-subdir',
              url: 'git@gitlab.semrush.net:ai/agent-marketplace.git',
              path: '.',
            },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      })
    );

    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Project');
    expect(stdout).toContain('Codex');
    expect(stdout).toContain('Marketplaces');
    expect(stdout).toContain('agent-marketplace git@gitlab.semrush.net:ai/agent-marketplace.git');
    expect(stdout).not.toContain('Plugins');
    expect(stdout).not.toContain('agent-marketplace .');
  });

  it('renders meaningful git-subdir marketplace paths', () => {
    mkdirSync(join(testDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(testDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            name: 'plugin-marketplace',
            source: {
              source: 'git-subdir',
              url: 'https://example.com/marketplace.git',
              path: 'plugins/foo',
            },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      })
    );

    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    const stdout = stripAnsi(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('plugin-marketplace https://example.com/marketplace.git plugins/foo');
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

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
