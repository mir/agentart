import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getCodexMarketplacePath,
  listCodexMarketplacePlugins,
  toCodexEntry,
  upsertCodexMarketplaceEntry,
} from './artifacts/plugins.ts';
import type { PluginCatalogItem } from './core/artifacts.ts';

describe('Codex plugin marketplace', () => {
  let testDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-plugin-marketplace-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    process.chdir(testDir);
    process.env.HOME = join(testDir, 'home');
    process.env.CODEX_HOME = join(testDir, 'home', '.codex');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  function plugin(name = 'my-plugin'): PluginCatalogItem {
    return {
      name,
      description: 'Plugin description',
      category: 'Productivity',
      configPath: `plugins/${name}`,
      source: { source: 'local', path: `./plugins/${name}` },
    };
  }

  it('creates a new marketplace file', async () => {
    await upsertCodexMarketplaceEntry('project', toCodexEntry(plugin(), 'AVAILABLE'));

    const data = JSON.parse(readFileSync(getCodexMarketplacePath('project'), 'utf-8'));
    expect(data.plugins).toEqual([
      {
        name: 'my-plugin',
        source: { source: 'local', path: './plugins/my-plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ]);
  });

  it('preserves existing marketplace metadata and entries', async () => {
    const path = getCodexMarketplacePath('project');
    mkdirSync(join(testDir, '.agents', 'plugins'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        metadata: { owner: 'user' },
        plugins: [
          {
            name: 'manual',
            source: { source: 'local', path: './manual' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Other',
          },
        ],
      })
    );

    await upsertCodexMarketplaceEntry('project', toCodexEntry(plugin(), 'INSTALLED_BY_DEFAULT'));

    const data = JSON.parse(readFileSync(path, 'utf-8'));
    expect(data.metadata).toEqual({ owner: 'user' });
    expect(data.plugins.map((entry: any) => entry.name)).toEqual(['manual', 'my-plugin']);
    expect(data.plugins.find((entry: any) => entry.name === 'my-plugin').policy.installation).toBe(
      'INSTALLED_BY_DEFAULT'
    );
  });

  it('rejects collisions with a different source', async () => {
    await upsertCodexMarketplaceEntry('project', toCodexEntry(plugin(), 'AVAILABLE'));

    await expect(
      upsertCodexMarketplaceEntry(
        'project',
        toCodexEntry(
          { ...plugin(), source: { source: 'local', path: './plugins/other' } },
          'AVAILABLE'
        )
      )
    ).rejects.toThrow('already contains plugin my-plugin');
  });

  it('lists local and global marketplace entries separately', async () => {
    await upsertCodexMarketplaceEntry('project', toCodexEntry(plugin('local-plugin'), 'AVAILABLE'));
    await upsertCodexMarketplaceEntry('global', toCodexEntry(plugin('global-plugin'), 'AVAILABLE'));

    expect((await listCodexMarketplacePlugins('project')).map((entry) => entry.name)).toEqual([
      'local-plugin',
    ]);
    expect((await listCodexMarketplacePlugins('global')).map((entry) => entry.name)).toEqual([
      'global-plugin',
    ]);
  });
});
