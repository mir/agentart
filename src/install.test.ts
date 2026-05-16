import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('install command', () => {
  let testDir: string;
  let sourceDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-install-test-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'sloprider-install-source-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    process.chdir(testDir);

    const homeDir = join(testDir, 'home');
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.CLAUDE_CONFIG_DIR = join(homeDir, '.claude');
    process.env.CODEX_HOME = join(homeDir, '.codex');
    process.env.XDG_CONFIG_HOME = join(homeDir, '.config');
    process.env.XDG_STATE_HOME = join(homeDir, '.local', 'state');

    vi.doMock('./repo/clone.ts', () => ({
      cleanupTempDir: vi.fn().mockResolvedValue(undefined),
      cloneRepo: vi.fn().mockResolvedValue(sourceDir),
      GitCloneError: class GitCloneError extends Error {},
    }));
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  function createSkill(name: string): void {
    const dir = join(sourceDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: ${name}
description: Test ${name}
---
# ${name}
`
    );
  }

  function createCodexHook(): void {
    mkdirSync(join(sourceDir, '.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'echo stop' }] } }, null, 2)
    );
  }

  function createCodexPlugin(name: string): void {
    const dir = join(sourceDir, 'plugins', name, '.codex-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({ name, description: `Test ${name}`, category: 'Productivity' }, null, 2)
    );
  }

  function createClaudeMarketplacePlugin(name: string): void {
    mkdirSync(join(sourceDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(sourceDir, 'plugins', name, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(
        {
          name: 'test-marketplace',
          owner: { name: 'Test' },
          plugins: [{ name, source: `./plugins/${name}` }],
        },
        null,
        2
      )
    );
    writeFileSync(
      join(sourceDir, 'plugins', name, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, description: `Test ${name}`, category: 'Productivity' }, null, 2)
    );
  }

  it('requires an explicit artifact list', async () => {
    const { runInstall } = await import('./commands/install.ts');

    await expect(
      runInstall(['https://example.com/acme/repo.git', '--scope', 'project', '--agents', 'codex'])
    ).rejects.toThrow('At least one of --skills, --mcps, --hooks, or --plugins is required');
  });

  it('rejects the removed local scope name', async () => {
    const { runInstall } = await import('./commands/install.ts');

    await expect(
      runInstall([
        'https://example.com/acme/repo.git',
        '--scope',
        'local',
        '--agents',
        'codex',
        '--skills',
        'alpha',
      ])
    ).rejects.toThrow('--scope must be project or global');
  });

  it('installs only explicitly named skills', async () => {
    createSkill('alpha');
    createSkill('beta');
    const { runInstall } = await import('./commands/install.ts');

    await runInstall([
      'https://example.com/acme/repo.git',
      '--scope',
      'project',
      '--agents',
      'codex',
      '--skills',
      'alpha',
    ]);

    expect(existsSync(join(testDir, '.agents', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.agents', 'skills', 'beta', 'SKILL.md'))).toBe(false);
  });

  it('rejects global hook installs', async () => {
    createCodexHook();
    const { runInstall } = await import('./commands/install.ts');

    await expect(
      runInstall([
        'https://example.com/acme/repo.git',
        '--scope',
        'global',
        '--agents',
        'codex',
        '--hooks',
        'codex-hooks',
      ])
    ).rejects.toThrow('Hooks are project-only');
  });

  it('installs explicitly named plugins into the Codex marketplace', async () => {
    createCodexPlugin('plugin-a');
    createCodexPlugin('plugin-b');
    const { runInstall } = await import('./commands/install.ts');

    await runInstall([
      'https://example.com/acme/repo.git',
      '--scope',
      'project',
      '--agents',
      'codex',
      '--plugins',
      'plugin-a',
    ]);

    const marketplace = JSON.parse(
      readFileSync(join(testDir, '.agents', 'plugins', 'marketplace.json'), 'utf-8')
    );
    expect(marketplace.plugins.map((plugin: any) => plugin.name)).toEqual(['plugin-a']);
    expect(marketplace.plugins[0].source).toEqual({
      source: 'git-subdir',
      url: 'https://example.com/acme/repo.git',
      path: './plugins/plugin-a',
    });

    const lock = JSON.parse(readFileSync(join(testDir, 'sloprider-plugins.json'), 'utf-8'));
    expect(lock.plugins['plugin-a'].agents).toEqual(['codex']);
  });

  it('adds Claude Code marketplaces with the original git URL', async () => {
    createClaudeMarketplacePlugin('plugin-a');
    const addMarketplaceForAgent = vi.fn().mockResolvedValue(undefined);
    const installPluginForAgent = vi.fn().mockResolvedValue({ success: true });
    vi.doMock('./artifacts/plugins.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./artifacts/plugins.ts')>()),
      getPluginCapableAgents: () => ['claude-code'],
      addMarketplaceForAgent,
      installPluginForAgent,
    }));
    const { runInstall } = await import('./commands/install.ts');

    await runInstall([
      'https://gitlab.example.com/group/repo.git',
      '--scope',
      'project',
      '--agents',
      'claude-code',
      '--plugins',
      'plugin-a',
    ]);

    expect(addMarketplaceForAgent).toHaveBeenCalledWith(
      'https://gitlab.example.com/group/repo.git',
      'claude-code',
      'project'
    );
    const lock = JSON.parse(readFileSync(join(testDir, 'sloprider-plugins.json'), 'utf-8'));
    expect(lock.plugins['plugin-a'].agents).toEqual(['claude-code']);
  });
});
