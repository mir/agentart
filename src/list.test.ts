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
import YAML from 'yaml';
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
    expect(parseYaml(result.stdout)).toEqual({});
  });

  it('lists project skills and MCPs as YAML', () => {
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      project: {
        skills: [{ name: 'test-skill', agents: [], location: '.agents/skills' }],
        mcps: [{ name: 'context7', agents: ['claude-code'], target: 'stdio: node server.js' }],
      },
    });
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.mcps).toEqual([
      {
        name: 'datachat',
        agents: ['claude-code'],
        target: 'http: http://127.0.0.1:8081/mcp/ (disabled)',
      },
    ]);
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.hooks).toEqual([
      {
        name: 'codex-hooks',
        agents: ['codex'],
        events: ['SessionStart', 'Stop'],
      },
    ]);
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({
      project: {
        plugins: [
          { name: 'project-plugin@demo', agents: ['claude-code'], source: '/tmp/project-plugin' },
        ],
      },
      global: {
        plugins: [
          {
            name: 'context7@claude-plugins-official',
            agents: ['claude-code'],
            source: '/tmp/context7',
          },
        ],
      },
    });

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
    const output = parseYaml(result.stdout);
    expect(output.project.plugins).toEqual([
      { name: 'hide-secrets', agents: ['claude-code'], source: 'plugins/redactor' },
    ]);
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

    expect(result.exitCode).toBe(0);
    expect(parseYaml(result.stdout)).toEqual({});
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.plugins).toEqual([
      { name: 'valid-plugin', agents: ['claude-code'], source: 'plugins/valid-plugin' },
    ]);
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.marketplace_entries).toEqual([
      {
        name: 'agent-marketplace',
        agents: ['codex'],
        source: 'git@gitlab.semrush.net:ai/agent-marketplace.git',
      },
    ]);
    expect(output.project.plugins).toBeUndefined();
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
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.marketplace_entries).toEqual([
      {
        name: 'plugin-marketplace',
        agents: ['codex'],
        source: 'https://example.com/marketplace.git plugins/foo',
      },
    ]);
  });

  it('groups shared project skills by location with multiple agents', () => {
    const homeDir = join(testDir, 'home');
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    mkdirSync(join(homeDir, '.cursor'), { recursive: true });
    const skillDir = join(testDir, '.agents', 'skills', 'shared-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: shared-skill
description: Shared
---
# Shared
`
    );

    const result = runCli(['list'], testDir, testHomeEnv(homeDir));
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.skills).toEqual([
      {
        name: 'shared-skill',
        agents: ['codex', 'cursor'],
        location: '.agents/skills',
      },
    ]);
  });

  it('lists global shared skills under global skills', () => {
    const homeDir = join(testDir, 'home');
    const skillDir = join(homeDir, '.codex', 'skills', 'global-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: global-skill
description: Global
---
# Global
`
    );

    const result = runCli(['list'], testDir, testHomeEnv(homeDir));
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.global.skills).toEqual([
      {
        name: 'global-skill',
        agents: ['codex'],
        location: '~/.codex/skills',
      },
    ]);
  });

  it('groups matching MCP targets across agents and splits different targets', () => {
    mkdirSync(join(testDir, '.codex'), { recursive: true });
    writeFileSync(
      join(testDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'node', args: ['./servers/filesystem.js'] },
          search: { command: 'node', args: ['./servers/search.js'] },
        },
      })
    );
    writeFileSync(
      join(testDir, '.codex', 'config.toml'),
      `
[mcp_servers.filesystem]
command = "node"
args = ["./servers/filesystem.js"]

[mcp_servers.search]
command = "bun"
args = ["./servers/search.ts"]
`
    );

    const result = runCli(['list'], testDir, testHomeEnv(join(testDir, 'home')));
    const output = parseYaml(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output.project.mcps).toEqual([
      {
        name: 'filesystem',
        agents: ['claude-code', 'codex'],
        target: 'stdio: node ./servers/filesystem.js',
      },
      {
        name: 'search',
        agents: ['codex'],
        target: 'stdio: bun ./servers/search.ts',
      },
      {
        name: 'search',
        agents: ['claude-code'],
        target: 'stdio: node ./servers/search.js',
      },
    ]);
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

function parseYaml(stdout: string): any {
  return YAML.parse(stdout);
}
