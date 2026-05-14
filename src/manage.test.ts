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
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-manage-test-'));
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
    vi.unstubAllGlobals();
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
      join(testDir, 'sloprider-lock.json'),
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

    expect(targets.map((target) => target.label)).toEqual([
      'project skill: updateable-skill (Shared)',
    ]);
  });

  it('updates managed hooks from their locked source path', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'sloprider-manage-hook-source-'));
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
      join(testDir, 'sloprider-hook-lock.json'),
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
      select: vi.fn().mockResolvedValueOnce('update-all').mockResolvedValueOnce('quit'),
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
      select: vi.fn().mockResolvedValueOnce('list-installed').mockResolvedValueOnce('quit'),
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

  it('returns to the menu after listing installed items', async () => {
    createProjectSkill('managed-list-loop-skill');
    const select = vi.fn().mockResolvedValueOnce('list-installed').mockResolvedValueOnce('quit');
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select,
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ''));
    };

    try {
      const { runManage } = await import('./manage.ts');
      await runManage({ showLogo: false });
    } finally {
      console.log = originalLog;
    }

    expect(select).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).toContain('managed-list-loop-skill');
  });

  it('includes remote MCP add in the manage menu', async () => {
    let labels: string[] = [];
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn().mockImplementation(({ options }) => {
        labels = options.map((option: { label: string }) => option.label);
        return 'quit';
      }),
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    const { runManage } = await import('./manage.ts');
    await runManage({ showLogo: false });

    expect(labels).toContain('Add remote MCP server');
  });

  it('adds a remote MCP server from the manage menu', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 405 })));
    let manageSelections = 0;
    const select = vi.fn().mockImplementation(({ message }) => {
      if (message === 'What do you want to do?') {
        manageSelections++;
        return manageSelections === 1 ? 'add-remote-mcp' : 'quit';
      }
      if (message === 'Installation scope') return 'project';
      throw new Error(`Unexpected select prompt: ${message}`);
    });
    const text = vi.fn().mockImplementation(({ message, initialValue }) => {
      if (message === 'Remote MCP URL') return 'https://api.example.com/mcp';
      if (message === 'MCP server name') {
        expect(initialValue).toBe('api.example.com');
        return 'api';
      }
      throw new Error(`Unexpected text prompt: ${message}`);
    });
    const multiselect = vi.fn().mockResolvedValue(['codex']);
    const confirm = vi.fn().mockResolvedValue(true);

    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select,
      text,
      multiselect,
      confirm,
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    const { runManage } = await import('./manage.ts');
    await runManage({ showLogo: false });

    const config = readFileSync(join(testDir, '.codex/config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers."api"]');
    expect(config).toContain('transport = "http"');
    expect(config).toContain('url = "https://api.example.com/mcp"');
    expect(
      JSON.parse(readFileSync(join(testDir, 'sloprider-mcp-lock.json'), 'utf-8')).mcps.api
    ).toMatchObject({
      source: 'https://api.example.com/mcp',
      sourceType: 'direct',
      server: {
        name: 'api',
        transport: 'http',
        url: 'https://api.example.com/mcp',
      },
    });
    expect(text).toHaveBeenCalledTimes(2);
    expect(multiselect).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({ message: 'Install this MCP server?' });
  });

  it('shows agent context for remove-selected labels', async () => {
    mkdirSync(join(testDir, 'home', '.codex'), { recursive: true });
    createProjectSkill('managed-remove-skill');
    writeFileSync(
      join(testDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          datachat: {
            type: 'http',
            url: 'http://127.0.0.1:8081/mcp/',
          },
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

    let labels: string[] = [];
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn().mockResolvedValueOnce('remove-selected').mockResolvedValueOnce('quit'),
      multiselect: vi.fn().mockImplementation(({ options }) => {
        labels = options.map((option: { label: string }) => option.label);
        return [];
      }),
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    const { runManage } = await import('./manage.ts');
    await runManage({ showLogo: false });

    expect(labels).toContain('project hook: codex-hooks (Codex)');
    expect(labels).toContain('project mcp: datachat (Claude Code)');
    expect(labels).toContain('project skill: managed-remove-skill (Codex)');
  });

  it('keeps discover from the manage menu interactive', async () => {
    const runInteractiveDiscover = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./discover.ts', () => ({
      runInteractiveDiscover,
      discoverRepo: vi.fn(),
    }));
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn().mockResolvedValueOnce('discover').mockResolvedValueOnce('quit'),
      text: vi.fn().mockResolvedValue('https://example.com/acme/repo.git'),
      cancel: vi.fn(),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));

    const { runManage } = await import('./manage.ts');
    await runManage({ showLogo: false });

    expect(runInteractiveDiscover).toHaveBeenCalledWith(['https://example.com/acme/repo.git']);
  });
});
