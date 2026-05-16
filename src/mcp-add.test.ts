import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('mcp add', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('orders candidates for scheme input', async () => {
    const { buildMcpUrlCandidates } = await import('./commands/mcp-add.ts');

    expect(buildMcpUrlCandidates('https://example.com/custom')).toEqual([
      'https://example.com/custom',
      'https://example.com/custom/mcp',
      'https://example.com/custom/mcp/',
    ]);
  });

  it('orders candidates for schemeless input', async () => {
    const { buildMcpUrlCandidates } = await import('./commands/mcp-add.ts');

    expect(buildMcpUrlCandidates('example.com')).toEqual([
      'https://example.com',
      'http://example.com',
      'https://example.com/mcp',
      'https://example.com/mcp/',
      'http://example.com/mcp',
      'http://example.com/mcp/',
    ]);
  });

  it('deduplicates existing /mcp candidates', async () => {
    const { buildMcpUrlCandidates } = await import('./commands/mcp-add.ts');

    expect(buildMcpUrlCandidates('https://example.com/mcp')).toEqual([
      'https://example.com/mcp',
      'https://example.com/mcp/',
    ]);
    expect(buildMcpUrlCandidates('https://example.com/mcp/')).toEqual([
      'https://example.com/mcp/',
      'https://example.com/mcp',
    ]);
  });

  it('defaults names from hostnames', async () => {
    const { defaultMcpName } = await import('./commands/mcp-add.ts');

    expect(defaultMcpName('https://api.example.com/mcp')).toBe('api.example.com');
    expect(defaultMcpName('https://www.example.com/mcp')).toBe('example.com');
    expect(defaultMcpName('http://localhost:3000/mcp')).toBe('localhost');
  });

  it('uses the first reachable candidate', async () => {
    const { probeMcpCandidates } = await import('./commands/mcp-add.ts');
    const fetchImpl = vi.fn(async () => new Response('', { status: 401, statusText: '' }));

    const result = await probeMcpCandidates(
      ['https://example.com/custom', 'https://example.com/custom/mcp'],
      {
        fetchImpl,
      }
    );

    expect(result.workingUrl).toBe('https://example.com/custom');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts successful, redirect, auth, and method statuses as reachable', async () => {
    const { probeMcpEndpoint } = await import('./commands/mcp-add.ts');

    for (const status of [200, 302, 401, 403, 405]) {
      const attempt = await probeMcpEndpoint('https://example.com/mcp', {
        fetchImpl: vi.fn(async () => new Response('', { status })),
      });
      expect(attempt.success).toBe(true);
    }
  });

  it('uses a later /mcp candidate after the original fails', async () => {
    const { probeMcpCandidates } = await import('./commands/mcp-add.ts');
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      return new Response('', {
        status: url.endsWith('/mcp') ? 200 : 404,
        statusText: url.endsWith('/mcp') ? 'OK' : 'Not Found',
      });
    });

    const result = await probeMcpCandidates(['https://example.com', 'https://example.com/mcp'], {
      fetchImpl,
    });

    expect(result.workingUrl).toBe('https://example.com/mcp');
    expect(result.attempts).toEqual([
      { url: 'https://example.com', success: false, result: '404 Not Found' },
      { url: 'https://example.com/mcp', success: true, result: '200 OK' },
    ]);
  });

  it('prefers a conventional /mcp/ endpoint over a reachable bare root', async () => {
    const { buildMcpUrlCandidates, probeMcpCandidates } = await import('./commands/mcp-add.ts');
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith('/mcp')) {
        return new Response('', {
          status: 307,
          statusText: 'Temporary Redirect',
          headers: { location: 'http://example.com/mcp/' },
        });
      }
      return new Response('', {
        status: url.endsWith('/mcp/') ? 401 : 200,
        statusText: url.endsWith('/mcp/') ? 'Unauthorized' : 'OK',
      });
    });

    const result = await probeMcpCandidates(buildMcpUrlCandidates('https://example.com/'), {
      fetchImpl,
    });

    expect(result.workingUrl).toBe('https://example.com/mcp/');
    expect(result.attempts.map((attempt) => attempt.url)).toEqual([
      'https://example.com/',
      'https://example.com/mcp',
    ]);
  });

  it('falls back to a reachable bare root when /mcp candidates fail', async () => {
    const { buildMcpUrlCandidates, probeMcpCandidates } = await import('./commands/mcp-add.ts');
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      return new Response('', {
        status: url.endsWith('/mcp') || url.endsWith('/mcp/') ? 404 : 200,
        statusText: url.endsWith('/mcp') || url.endsWith('/mcp/') ? 'Not Found' : 'OK',
      });
    });

    const result = await probeMcpCandidates(buildMcpUrlCandidates('https://example.com/'), {
      fetchImpl,
    });

    expect(result.workingUrl).toBe('https://example.com/');
  });

  it('reports every attempted URL when all candidates fail', async () => {
    const { formatProbeFailure, probeMcpCandidates } = await import('./commands/mcp-add.ts');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 404, statusText: '' }))
      .mockRejectedValueOnce(new Error('connection refused'));

    const result = await probeMcpCandidates(['https://example.com', 'http://example.com'], {
      fetchImpl,
    });

    expect(result.workingUrl).toBeUndefined();
    expect(formatProbeFailure(result.attempts)).toBe(
      [
        'Could not find a reachable MCP endpoint.',
        '',
        'Tried:',
        '  https://example.com -> 404 Not Found',
        '  http://example.com -> connection refused',
      ].join('\n')
    );
  });

  it('does not write config or lock files when probing fails', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'sloprider-mcp-add-fail-test-'));
    const originalCwd = process.cwd();
    const originalEnv = { ...process.env };
    const homeDir = join(testDir, 'home');

    try {
      process.chdir(testDir);
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.CLAUDE_CONFIG_DIR = join(homeDir, '.claude');
      process.env.CODEX_HOME = join(homeDir, '.codex');
      process.env.XDG_CONFIG_HOME = join(homeDir, '.config');
      process.env.XDG_STATE_HOME = join(homeDir, '.local', 'state');
      vi.resetModules();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
      vi.doMock('@clack/prompts', () => ({
        default: {},
        intro: vi.fn(),
        outro: vi.fn(),
        log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
      }));

      const { runMcpAdd } = await import('./commands/mcp-add.ts');
      await expect(
        runMcpAdd([
          'add',
          'https://api.example.com',
          '--name',
          'api',
          '--scope',
          'project',
          '--agents',
          'codex',
        ])
      ).rejects.toThrow('Could not find a reachable MCP endpoint.');

      expect(existsSync(join(testDir, '.codex/config.toml'))).toBe(false);
      expect(existsSync(join(testDir, 'sloprider-mcp-lock.json'))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      process.env = originalEnv;
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('writes Codex local config and lock metadata', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'sloprider-mcp-add-test-'));
    const originalCwd = process.cwd();
    const originalEnv = { ...process.env };
    const homeDir = join(testDir, 'home');

    try {
      process.chdir(testDir);
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      process.env.CLAUDE_CONFIG_DIR = join(homeDir, '.claude');
      process.env.CODEX_HOME = join(homeDir, '.codex');
      process.env.XDG_CONFIG_HOME = join(homeDir, '.config');
      process.env.XDG_STATE_HOME = join(homeDir, '.local', 'state');
      vi.resetModules();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const url = String(input);
          if (url.endsWith('/mcp')) {
            return new Response('', {
              status: 307,
              statusText: 'Temporary Redirect',
              headers: { location: 'http://api.example.com/mcp/' },
            });
          }
          return new Response('', {
            status: url.endsWith('/mcp/') ? 401 : 200,
            statusText: url.endsWith('/mcp/') ? 'Unauthorized' : 'OK',
          });
        })
      );
      vi.doMock('@clack/prompts', () => ({
        default: {},
        intro: vi.fn(),
        outro: vi.fn(),
        log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
      }));

      const { runMcpAdd } = await import('./commands/mcp-add.ts');
      await runMcpAdd([
        'add',
        'https://api.example.com/',
        '--name',
        'api',
        '--scope',
        'project',
        '--agents',
        'codex',
      ]);
      const url = 'https://api.example.com/mcp/';

      const config = readFileSync(join(testDir, '.codex/config.toml'), 'utf-8');
      expect(config).toContain('[mcp_servers."api"]');
      expect(config).toContain('transport = "http"');
      expect(config).toContain(`url = "${url}"`);

      const lock = JSON.parse(readFileSync(join(testDir, 'sloprider-mcp-lock.json'), 'utf-8'));
      expect(lock.mcps.api.server).toEqual({
        name: 'api',
        transport: 'http',
        url,
      });
      expect(lock.mcps.api.source).toBe(url);
      expect(lock.mcps.api.sourceType).toBe('direct');
    } finally {
      process.chdir(originalCwd);
      process.env = originalEnv;
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    }
  });
});
