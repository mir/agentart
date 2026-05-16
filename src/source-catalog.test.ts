import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

describe('source catalog', () => {
  let testDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-source-catalog-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    process.chdir(testDir);

    const homeDir = join(testDir, 'home');
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.CODEX_HOME = join(homeDir, '.codex');
    process.env.XDG_STATE_HOME = join(homeDir, '.local', 'state');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('collects and dedupes git-backed marketplace and lock sources', async () => {
    const { getCodexMarketplacePath } = await import('./artifacts/plugins.ts');
    mkdirSync(join(testDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      join(testDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          {
            name: 'market-plugin',
            source: {
              source: 'git-subdir',
              url: 'https://github.com/acme/marketplace.git',
              path: './plugins/market-plugin',
              ref: 'main',
            },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
          {
            name: 'local-plugin',
            source: { source: 'project', path: './plugins/local-plugin' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      })
    );

    const globalMarketplacePath = getCodexMarketplacePath('global');
    mkdirSync(dirname(globalMarketplacePath), { recursive: true });
    writeFileSync(
      globalMarketplacePath,
      JSON.stringify({
        plugins: [
          {
            name: 'global-market-plugin',
            source: {
              source: 'git-subdir',
              url: 'https://github.com/acme/global-market.git',
              path: './plugins/global-market-plugin',
            },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      })
    );

    writeFileSync(
      join(testDir, 'sloprider-lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          alpha: {
            source: 'acme/marketplace',
            sourceType: 'github',
            ref: 'main',
            skillPath: 'skills/alpha/SKILL.md',
            computedHash: 'hash',
          },
          local: {
            source: './skills/local',
            sourceType: 'project',
            computedHash: 'hash',
          },
        },
      })
    );

    writeFileSync(
      join(testDir, 'sloprider-mcp-lock.json'),
      JSON.stringify({
        version: 1,
        mcps: {
          direct: {
            server: { name: 'direct', transport: 'http', url: 'https://api.example.com/mcp' },
            source: 'https://api.example.com/mcp',
            sourceType: 'direct',
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
          git: {
            server: { name: 'git', transport: 'stdio', command: 'server' },
            source: 'https://github.com/acme/mcp.git',
            sourceType: 'git',
            installedAt: '2026-05-12T00:00:00.000Z',
            updatedAt: '2026-05-12T00:00:00.000Z',
          },
        },
      })
    );

    const { collectSavedSources } = await import('./source-catalog.ts');
    const sources = await collectSavedSources();

    expect(sources.map((source) => source.source)).toEqual([
      'https://github.com/acme/marketplace.git#main',
      'https://github.com/acme/global-market.git',
      'https://github.com/acme/mcp.git',
    ]);
    expect(sources.map((source) => source.label)).toEqual([
      'project marketplace: acme/marketplace',
      'global marketplace: acme/global-market',
      'previous install: acme/mcp',
    ]);
  });
});
