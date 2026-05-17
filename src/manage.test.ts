import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ManageMenuAction, ManageMenuRow } from './ui/manage-menu.ts';

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

  function createProjectMcp(name = 'datachat'): void {
    writeFileSync(
      join(testDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          [name]: {
            type: 'http',
            url: 'http://127.0.0.1:8081/mcp/',
          },
        },
      })
    );
    writeFileSync(
      join(testDir, 'sloprider-mcp-lock.json'),
      JSON.stringify(
        {
          version: 1,
          mcps: {
            [name]: {
              name,
              source: 'https://github.com/acme/mcps.git',
              sourceType: 'git',
              sourceSha: 'oldsha',
              server: {
                name,
                transport: 'http',
                url: 'http://127.0.0.1:8081/mcp/',
              },
              agents: ['claude-code'],
            },
          },
        },
        null,
        2
      )
    );
  }

  function mockPrompts() {
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      select: vi.fn(),
      text: vi.fn(),
      multiselect: vi.fn(),
      confirm: vi.fn(),
      cancel: vi.fn(),
      spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));
  }

  function mockMenu(actions: ManageMenuAction[], seenRows: ManageMenuRow[][] = []) {
    vi.doMock('./ui/manage-menu.ts', async () => {
      const actual =
        await vi.importActual<typeof import('./ui/manage-menu.ts')>('./ui/manage-menu.ts');
      return {
        ...actual,
        promptManageMenu: vi.fn().mockImplementation((rows: ManageMenuRow[]) => {
          seenRows.push(rows);
          return actions.shift() ?? { type: 'quit' };
        }),
      };
    });
  }

  it('shows inventory counts in the main menu and omits legacy actions', async () => {
    createProjectSkill('project-skill');
    createProjectMcp();
    const rows: ManageMenuRow[][] = [];
    mockPrompts();
    mockMenu([{ type: 'quit' }], rows);

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    const labels = rows[0]!.map((row) => row.label);
    expect(labels).toContain('Project');
    expect(rows[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Skills', count: 1 }),
        expect.objectContaining({ label: 'MCPs', count: 1 }),
      ])
    );
    expect(labels).not.toEqual(
      expect.arrayContaining([
        'List installed',
        'Remove selected',
        'Update selected',
        'Update all',
        'Discover from git URL',
        'Install from saved source',
      ])
    );
  });

  it('removes a selected project MCP through the artifact action menu', async () => {
    createProjectMcp();
    mockPrompts();
    mockMenu([
      { type: 'category', scope: 'project', kind: 'mcp' },
      { type: 'artifact', key: 'project:mcp:datachat' },
      { type: 'artifact-action', action: 'remove' },
      { type: 'quit' },
    ]);

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    expect(readFileSync(join(testDir, '.mcp.json'), 'utf-8')).not.toContain('datachat');
  });

  it('shows update only for stale items and records successful MCP updates', async () => {
    createProjectMcp();
    const recordUpdatedSha = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./freshness.ts', () => ({
      findOutdatedItems: vi.fn().mockResolvedValue([
        {
          kind: 'mcp',
          name: 'datachat',
          scope: 'project',
          sourceUrl: 'https://github.com/acme/mcps.git',
          installedSha: 'oldsha',
          remoteSha: 'newsha',
        },
      ]),
      recordUpdatedSha,
    }));
    const rows: ManageMenuRow[][] = [];
    mockPrompts();
    mockMenu(
      [
        { type: 'category', scope: 'project', kind: 'mcp' },
        { type: 'artifact', key: 'project:mcp:datachat' },
        { type: 'artifact-action', action: 'update' },
        { type: 'quit' },
      ],
      rows
    );

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    expect(rows[2]).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Update' })]));
    expect(recordUpdatedSha).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'mcp', name: 'datachat', remoteSha: 'newsha' })
    );
  });

  it('shows update status in category rows for stale items', async () => {
    createProjectMcp();
    vi.doMock('./freshness.ts', () => ({
      findOutdatedItems: vi.fn().mockResolvedValue([
        {
          kind: 'mcp',
          name: 'datachat',
          scope: 'project',
          sourceUrl: 'https://github.com/acme/mcps.git',
          installedSha: 'oldsha',
          remoteSha: 'newsha',
        },
      ]),
      recordUpdatedSha: vi.fn(),
    }));
    const rows: ManageMenuRow[][] = [];
    mockPrompts();
    mockMenu(
      [{ type: 'category', scope: 'project', kind: 'mcp' }, { type: 'back' }, { type: 'quit' }],
      rows
    );

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    expect(rows[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'datachat',
          hint: expect.stringContaining('update available'),
        }),
      ])
    );
  });

  it('expands install sources and supports Add git repo', async () => {
    const runInteractiveInstallFromSource = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./commands/discover.ts', () => ({
      discoverRepo: vi.fn(),
      runInteractiveInstallFromSource,
    }));
    vi.doMock('./source-catalog.ts', () => ({
      collectSavedSources: vi.fn().mockResolvedValue([
        {
          kind: 'project marketplace',
          source: 'https://github.com/acme/marketplace.git#main',
          name: 'marketplace',
          label: 'project marketplace: acme/marketplace',
        },
      ]),
    }));
    const rows: ManageMenuRow[][] = [];
    mockPrompts();
    mockMenu(
      [
        { type: 'install' },
        { type: 'install-source', index: 0 },
        { type: 'install' },
        { type: 'install-add-git-repo' },
        { type: 'quit' },
      ],
      rows
    );
    const prompts = await import('@clack/prompts');
    vi.mocked(prompts.text).mockResolvedValue('https://github.com/acme/repo.git' as never);

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    expect(rows[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'marketplace',
          hint: 'https://github.com/acme/marketplace.git#main',
        }),
        expect.objectContaining({ label: 'Add git repo' }),
      ])
    );
    expect(runInteractiveInstallFromSource).toHaveBeenCalledWith(
      'https://github.com/acme/marketplace.git#main',
      'sloprider install from saved source'
    );
    expect(runInteractiveInstallFromSource).toHaveBeenCalledWith(
      'https://github.com/acme/repo.git',
      'sloprider install from git repo'
    );
  });

  it('removes marketplace entries through the marketplace-entry path', async () => {
    mkdirSync(join(testDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(testDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            name: 'acme-market',
            source: { source: 'git-subdir', url: 'https://github.com/acme/market.git', path: '.' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      })
    );
    mockPrompts();
    mockMenu([
      { type: 'category', scope: 'project', kind: 'marketplace-entry' },
      { type: 'artifact', key: 'project:marketplace-entry:acme-market' },
      { type: 'artifact-action', action: 'remove' },
      { type: 'quit' },
    ]);

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    expect(
      readFileSync(join(testDir, '.agents', 'plugins', 'marketplace.json'), 'utf-8')
    ).not.toContain('acme-market');
  });

  it('starts direct MCP endpoint install from the manage menu', async () => {
    const runInteractiveMcpAdd = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./commands/mcp-add.ts', () => ({
      runInteractiveMcpAdd,
    }));
    mockPrompts();
    mockMenu([{ type: 'add-mcp' }, { type: 'quit' }]);

    const { runManage } = await import('./commands/manage.ts');
    await runManage({ showLogo: false });

    expect(runInteractiveMcpAdd).toHaveBeenCalledOnce();
  });
});
