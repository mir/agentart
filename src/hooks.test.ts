import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  discoverHooks,
  installHookBundle,
  listInstalledHooks,
  removeHookBundle,
  type DiscoveredHookBundle,
} from './hooks.ts';
import type { ParsedSource } from './types.ts';

const parsed: ParsedSource = { type: 'git', url: 'https://example.com/acme/hooks.git' };

describe('hooks', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), 'sloprider-hook-source-'));
    targetDir = mkdtempSync(join(tmpdir(), 'sloprider-hook-target-'));
  });

  afterEach(() => {
    for (const dir of [sourceDir, targetDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discovers Codex hooks.json bundles', async () => {
    mkdirSync(join(sourceDir, '.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: 'echo hi' }] } })
    );

    const hooks = await discoverHooks(sourceDir);

    expect(hooks).toMatchObject([
      {
        name: 'codex-hooks',
        agent: 'codex',
        sourcePath: '.codex/hooks.json',
        events: ['SessionStart'],
      },
    ]);
  });

  it('discovers nested hook bundles for Codex, Claude, and Copilot', async () => {
    mkdirSync(join(sourceDir, 'plugins/foo/.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.codex/hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: 'echo codex' }] } })
    );

    mkdirSync(join(sourceDir, 'plugins/foo/.claude'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.claude/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } })
    );

    mkdirSync(join(sourceDir, 'plugins/foo/.github/hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.github/hooks/project.json'),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'echo copilot' }] } })
    );

    const hooks = await discoverHooks(sourceDir);

    expect(hooks).toMatchObject([
      {
        name: 'claude-hooks',
        agent: 'claude-code',
        sourcePath: 'plugins/foo/.claude/settings.json',
      },
      {
        name: 'codex-hooks',
        agent: 'codex',
        sourcePath: 'plugins/foo/.codex/hooks.json',
      },
      {
        name: 'copilot-project',
        agent: 'github-copilot',
        sourcePath: 'plugins/foo/.github/hooks/project.json',
      },
    ]);
  });

  it('skips Codex inline TOML hooks', async () => {
    mkdirSync(join(sourceDir, '.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'config.toml'),
      '[[hooks.PreToolUse]]\ncommand = "x"\n'
    );

    await expect(discoverHooks(sourceDir)).resolves.toEqual([]);
  });

  it('detects nested Codex inline TOML hooks as unsupported', async () => {
    mkdirSync(join(sourceDir, 'plugins/foo/.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.codex/config.toml'),
      '[[hooks.PreToolUse]]\ncommand = "x"\n'
    );

    await expect(discoverHooks(sourceDir)).resolves.toEqual([]);
  });

  it('installs Codex hooks, enables codex_hooks, and preserves unrelated TOML', async () => {
    mkdirSync(join(sourceDir, '.codex', 'hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: '.codex/hooks/start.sh' }] } })
    );
    writeFileSync(join(sourceDir, '.codex', 'hooks', 'start.sh'), 'echo start\n');
    mkdirSync(join(targetDir, '.codex'), { recursive: true });
    writeFileSync(join(targetDir, '.codex', 'config.toml'), 'model = "gpt-5"\n');

    const [hook] = await discoverHooks(sourceDir);
    const result = await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);

    expect(result.success).toBe(true);
    const hooksJson = JSON.parse(readFileSync(join(targetDir, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooksJson.hooks.SessionStart).toHaveLength(1);
    const config = readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain('[features]');
    expect(config).toContain('codex_hooks = true');
    expect(readFileSync(join(targetDir, '.codex', 'hooks', 'start.sh'), 'utf-8')).toBe(
      'echo start\n'
    );
  });

  it('copies Codex assets from a nested hook bundle directory', async () => {
    mkdirSync(join(sourceDir, 'plugins/foo/.codex/hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.codex/hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: '.codex/hooks/start.sh' }] } })
    );
    writeFileSync(join(sourceDir, 'plugins/foo/.codex/hooks/start.sh'), 'echo nested start\n');

    const [hook] = await discoverHooks(sourceDir);
    const result = await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);

    expect(result.success).toBe(true);
    expect(readFileSync(join(targetDir, '.codex', 'hooks', 'start.sh'), 'utf-8')).toBe(
      'echo nested start\n'
    );
  });

  it('installs Claude hooks while preserving unrelated settings', async () => {
    mkdirSync(join(sourceDir, '.claude'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } })
    );
    mkdirSync(join(targetDir, '.claude'), { recursive: true });
    writeFileSync(join(targetDir, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }));

    const [hook] = await discoverHooks(sourceDir);
    const result = await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);

    expect(result.success).toBe(true);
    const settings = JSON.parse(readFileSync(join(targetDir, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('copies Claude assets from a nested hook bundle directory', async () => {
    mkdirSync(join(sourceDir, 'plugins/foo/.claude/hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.claude/settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] } })
    );
    writeFileSync(join(sourceDir, 'plugins/foo/.claude/hooks/pre-tool-use.sh'), 'echo claude\n');

    const [hook] = await discoverHooks(sourceDir);
    const result = await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);

    expect(result.success).toBe(true);
    expect(readFileSync(join(targetDir, '.claude', 'hooks', 'pre-tool-use.sh'), 'utf-8')).toBe(
      'echo claude\n'
    );
  });

  it('installs Copilot hooks as managed files', async () => {
    mkdirSync(join(sourceDir, '.github', 'hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.github', 'hooks', 'project-hooks.json'),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'echo hi' }] } })
    );

    const [hook] = await discoverHooks(sourceDir);
    const result = await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);

    expect(result.success).toBe(true);
    expect(
      existsSync(join(targetDir, '.github', 'hooks', 'sloprider-copilot-project-hooks.json'))
    ).toBe(true);
  });

  it('removes only locked hook groups and copied files', async () => {
    mkdirSync(join(sourceDir, '.codex', 'hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: '.codex/hooks/stop.sh' }] } })
    );
    writeFileSync(join(sourceDir, '.codex', 'hooks', 'stop.sh'), 'echo stop\n');
    mkdirSync(join(targetDir, '.codex'), { recursive: true });
    writeFileSync(
      join(targetDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: 'manual' }] } })
    );

    const [hook] = await discoverHooks(sourceDir);
    await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);
    await removeHookBundle('codex-hooks', targetDir);

    const hooksJson = JSON.parse(readFileSync(join(targetDir, '.codex', 'hooks.json'), 'utf-8'));
    expect(hooksJson.hooks.Stop).toEqual([{ command: 'manual' }]);
    expect(existsSync(join(targetDir, '.codex', 'hooks', 'stop.sh'))).toBe(false);
  });

  it('does not overwrite or remove edited copied files', async () => {
    mkdirSync(join(sourceDir, '.codex', 'hooks'), { recursive: true });
    writeFileSync(
      join(sourceDir, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ command: '.codex/hooks/stop.sh' }] } })
    );
    writeFileSync(join(sourceDir, '.codex', 'hooks', 'stop.sh'), 'echo stop\n');

    const [hook] = await discoverHooks(sourceDir);
    await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);
    writeFileSync(join(targetDir, '.codex', 'hooks', 'stop.sh'), 'user edit\n');

    const reinstall = await installHookBundle(sourceDir, hook!, parsed, parsed.url, targetDir);
    expect(reinstall.success).toBe(false);

    await removeHookBundle('codex-hooks', targetDir);
    expect(readFileSync(join(targetDir, '.codex', 'hooks', 'stop.sh'), 'utf-8')).toBe(
      'user edit\n'
    );
  });

  it('lists managed hooks from the hook lock', async () => {
    const hook: DiscoveredHookBundle = {
      name: 'codex-hooks',
      agent: 'codex',
      sourcePath: '.codex/hooks.json',
      events: ['SessionStart'],
      hooks: { SessionStart: [{ command: 'echo hi' }] },
    };
    mkdirSync(join(sourceDir, '.codex'), { recursive: true });
    writeFileSync(join(sourceDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: hook.hooks }));

    await installHookBundle(sourceDir, hook, parsed, parsed.url, targetDir);

    await expect(listInstalledHooks(targetDir)).resolves.toMatchObject([
      { name: 'codex-hooks', agent: 'codex', events: ['SessionStart'] },
    ]);
  });
});
