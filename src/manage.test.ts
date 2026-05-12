import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('manage command', () => {
  let testDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    testDir = mkdtempSync(join(tmpdir(), 'agentart-manage-test-'));
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    vi.restoreAllMocks();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function createProjectSkill(name: string): void {
    const skillDir = join(testDir, '.agents', 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: ${name}
description: Test skill
---
# ${name}
`
    );
  }

  it('omits installed skills that do not have updatable lock metadata', async () => {
    createProjectSkill('updateable-skill');
    createProjectSkill('manual-skill');
    createProjectSkill('local-source-skill');
    writeFileSync(
      join(testDir, 'agentart-lock.json'),
      JSON.stringify(
        {
          version: 1,
          skills: {
            'updateable-skill': {
              source: 'owner/repo',
              sourceType: 'github',
              skillPath: 'skills/updateable-skill/SKILL.md',
              computedHash: 'hash',
            },
            'local-source-skill': {
              source: testDir,
              sourceType: 'local',
              skillPath: 'SKILL.md',
              computedHash: 'hash',
            },
          },
        },
        null,
        2
      )
    );

    const { updatableInstalledTargets } = await import('./manage.ts');
    const targets = await updatableInstalledTargets();

    expect(targets.map((target) => target.label)).toEqual(['project skill: updateable-skill']);
  });

  it('updates managed hooks from their locked source path', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'agentart-manage-hook-source-'));
    mkdirSync(join(sourceDir, '.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'new' }] } })
    );
    mkdirSync(join(testDir, '.codex'), { recursive: true });
    writeFileSync(
      join(testDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'old' }] } })
    );
    writeFileSync(
      join(testDir, 'agentart-hook-lock.json'),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            'codex-hooks': {
              name: 'codex-hooks',
              agent: 'codex',
              source: 'https://example.com/acme/hooks.git',
              sourceType: 'git',
              sourcePath: '.codex/hooks.json',
              targetPath: '.codex/hooks.json',
              events: ['Stop'],
              hooks: { Stop: [{ command: 'old' }] },
              copiedFiles: {},
              installedAt: '2026-05-12T00:00:00.000Z',
              updatedAt: '2026-05-12T00:00:00.000Z',
            },
          },
        },
        null,
        2
      )
    );

    vi.doMock('./git.ts', () => ({
      cleanupTempDir: vi.fn().mockResolvedValue(undefined),
      cloneRepo: vi.fn().mockResolvedValue(sourceDir),
      GitCloneError: class GitCloneError extends Error {},
    }));
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn().mockResolvedValue('update-all'),
      spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    const { runManage } = await import('./manage.ts');
    await runManage({ showLogo: false });

    const hooksJson = JSON.parse(readFileSync(join(testDir, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooksJson.hooks.Stop).toEqual([{ command: 'new' }]);

    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('prints the logo when manage starts by default', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ''));
    };
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn().mockResolvedValue('quit'),
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    try {
      const { runManage } = await import('./manage.ts');
      await runManage();
    } finally {
      console.log = originalLog;
    }

    expect(logs.join('\n')).toContain('███');
  });

  it('can list installed skills from the manage menu', async () => {
    createProjectSkill('managed-list-skill');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ''));
    };
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn().mockResolvedValue('list-installed'),
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    try {
      const { runManage } = await import('./manage.ts');
      await runManage({ showLogo: false });
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    expect(output).toContain('Project');
    expect(output).toContain('Skills');
    expect(output).toContain('managed-list-skill');
  });
});
