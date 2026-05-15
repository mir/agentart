import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('findOutdatedItems', () => {
  let testDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    testDir = mkdtempSync(join(tmpdir(), 'sloprider-freshness-test-'));
    originalCwd = process.cwd();
    originalEnv = { ...process.env };
    process.chdir(testDir);

    const homeDir = join(testDir, 'home');
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.XDG_STATE_HOME = join(homeDir, '.local', 'state');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reports outdated plugins when the remote SHA differs', async () => {
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'demo-plugin': {
            name: 'demo-plugin',
            agents: ['claude-code'],
            scope: 'project',
            source: 'git@example.com:demo.git',
            sourceType: 'git',
            sourceUrl: 'git@example.com:demo.git',
            pluginPath: '.',
            pluginSource: { source: 'git-subdir', url: 'git@example.com:demo.git', path: '.' },
            sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            installedAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      })
    );

    vi.doMock('./git-sha.ts', () => ({
      lsRemoteSha: vi.fn().mockResolvedValue('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      getCommitSha: vi.fn(),
    }));

    const { findOutdatedItems } = await import('./freshness.ts');
    const out = await findOutdatedItems();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'plugin',
      name: 'demo-plugin',
      scope: 'project',
      installedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      remoteSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
  });

  it('skips items whose remote SHA matches', async () => {
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'demo-plugin': {
            name: 'demo-plugin',
            agents: ['claude-code'],
            scope: 'project',
            source: 'git@example.com:demo.git',
            sourceType: 'git',
            sourceUrl: 'git@example.com:demo.git',
            pluginPath: '.',
            pluginSource: { source: 'git-subdir', url: 'git@example.com:demo.git', path: '.' },
            sourceSha: 'ccccccccccccccccccccccccccccccccccccccc',
            installedAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      })
    );

    vi.doMock('./git-sha.ts', () => ({
      lsRemoteSha: vi.fn().mockResolvedValue('ccccccccccccccccccccccccccccccccccccccc'),
      getCommitSha: vi.fn(),
    }));

    const { findOutdatedItems } = await import('./freshness.ts');
    const out = await findOutdatedItems();
    expect(out).toEqual([]);
  });

  it('skips entries without a recorded sourceSha', async () => {
    writeFileSync(
      join(testDir, 'sloprider-plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'demo-plugin': {
            name: 'demo-plugin',
            agents: ['claude-code'],
            scope: 'project',
            source: 'git@example.com:demo.git',
            sourceType: 'git',
            sourceUrl: 'git@example.com:demo.git',
            pluginPath: '.',
            pluginSource: { source: 'git-subdir', url: 'git@example.com:demo.git', path: '.' },
            installedAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      })
    );

    const lsRemote = vi.fn();
    vi.doMock('./git-sha.ts', () => ({ lsRemoteSha: lsRemote, getCommitSha: vi.fn() }));

    const { findOutdatedItems } = await import('./freshness.ts');
    const out = await findOutdatedItems();
    expect(out).toEqual([]);
    expect(lsRemote).not.toHaveBeenCalled();
  });
});
