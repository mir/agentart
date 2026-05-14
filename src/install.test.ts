import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

    vi.doMock('./git.ts', () => ({
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

  it('requires an explicit artifact list', async () => {
    const { runInstall } = await import('./install.ts');

    await expect(
      runInstall(['https://example.com/acme/repo.git', '--scope', 'local', '--agents', 'codex'])
    ).rejects.toThrow('At least one of --skills, --mcps, or --hooks is required');
  });

  it('installs only explicitly named skills', async () => {
    createSkill('alpha');
    createSkill('beta');
    const { runInstall } = await import('./install.ts');

    await runInstall([
      'https://example.com/acme/repo.git',
      '--scope',
      'local',
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
    const { runInstall } = await import('./install.ts');

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
});
