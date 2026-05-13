import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('discover command', () => {
  let sourceDir: string;
  let originalLog: typeof console.log;
  let logs: string[];
  let spinnerStart: ReturnType<typeof vi.fn>;
  let spinnerMessage: ReturnType<typeof vi.fn>;
  let spinnerStop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sourceDir = mkdtempSync(join(tmpdir(), 'agentart-discover-source-'));
    logs = [];
    spinnerStart = vi.fn();
    spinnerMessage = vi.fn();
    spinnerStop = vi.fn();
    originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ''));
    };

    vi.doMock('./git.ts', () => ({
      cleanupTempDir: vi.fn().mockResolvedValue(undefined),
      cloneRepo: vi.fn().mockResolvedValue(sourceDir),
      GitCloneError: class GitCloneError extends Error {},
    }));
    vi.doMock('@clack/prompts', () => ({
      default: {},
      intro: vi.fn(),
      outro: vi.fn(),
      groupMultiselect: vi.fn(),
      multiselect: vi.fn(),
      select: vi.fn(),
      confirm: vi.fn(),
      spinner: () => ({ start: spinnerStart, message: spinnerMessage, stop: spinnerStop }),
      log: { warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(() => {
    console.log = originalLog;
    vi.restoreAllMocks();
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('prints inventory and an explicit install command without prompting', async () => {
    const skillDir = join(sourceDir, 'skills', 'alpha');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: alpha
description: Test alpha
---
# alpha
`
    );

    const prompts = await import('@clack/prompts');
    const { runDiscover } = await import('./discover.ts');

    await runDiscover(['https://example.com/acme/repo.git']);

    const output = logs.join('\n');
    expect(output).toContain('Skills:');
    expect(output).toContain('alpha - skills/alpha - Test alpha');
    expect(output).toContain(
      'agentart install https://example.com/acme/repo.git --scope local --agents all --skills alpha'
    );
    expect(prompts.multiselect).not.toHaveBeenCalled();
    expect(prompts.select).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it('prints nested skills, MCP servers, and hooks from repo-root discovery', async () => {
    const skillDir = join(sourceDir, 'plugins', 'alpha', 'skills', 'nested');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: nested
description: Nested skill
---
# nested
`
    );

    mkdirSync(join(sourceDir, 'plugins/semrush-context'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/semrush-context/.mcp.json'),
      JSON.stringify({ mcpServers: { semrush: { command: 'semrush-mcp' } } })
    );

    mkdirSync(join(sourceDir, 'plugins/foo/.codex'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'plugins/foo/.codex/hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ command: 'echo hi' }] } })
    );

    const { runDiscover } = await import('./discover.ts');

    await runDiscover(['https://example.com/acme/repo.git']);

    const output = logs.join('\n');
    expect(output).toContain('Found 1 skill(s), 1 MCP server(s), and 1 hook bundle(s).');
    expect(output).toContain('nested - plugins/alpha/skills/nested - Nested skill');
    expect(output).toContain('semrush - plugins/semrush-context/.mcp.json - semrush-mcp');
    expect(output).toContain('codex-hooks - Codex (SessionStart)');
    expect(output).toContain(
      'agentart install https://example.com/acme/repo.git --scope local --agents all --skills nested --mcps semrush --hooks codex-hooks'
    );
  });

  it('builds selector groups with source paths for duplicate skills and MCPs', async () => {
    const { artifactSelectOptions } = await import('./discover.ts');
    const skillA = {
      name: 'hello',
      description: 'A skill',
      path: join(sourceDir, 'a/skills/hello'),
    };
    const skillB = {
      name: 'hello',
      description: 'B skill',
      path: join(sourceDir, 'b/skills/hello'),
    };
    const groups = artifactSelectOptions(
      sourceDir,
      [skillA, skillB],
      [
        {
          name: 'confluence',
          transport: 'http',
          url: 'https://one.test',
          sourcePath: 'docker/devbox/opencode.json',
        },
        {
          name: 'confluence',
          transport: 'http',
          url: 'https://two.test',
          sourcePath: 'plugins/integrations/.mcp.json',
        },
      ],
      []
    );

    expect(Object.keys(groups)).toEqual([
      'Skills',
      'MCP servers from docker/devbox/opencode.json',
      'MCP servers from plugins/integrations/.mcp.json',
    ]);
    expect(groups.Skills?.map((option) => option.label)).toEqual([
      'skill: hello [a/skills/hello]',
      'skill: hello [b/skills/hello]',
    ]);
    expect(groups['MCP servers from docker/devbox/opencode.json']?.[0]?.label).toBe(
      'mcp: confluence [docker/devbox/opencode.json]'
    );
    expect(groups['MCP servers from plugins/integrations/.mcp.json']?.[0]?.label).toBe(
      'mcp: confluence [plugins/integrations/.mcp.json]'
    );
  });

  it('includes conflicting sources in duplicate selection errors', async () => {
    const { assertNoDuplicateNames } = await import('./discover.ts');

    expect(() =>
      assertNoDuplicateNames(sourceDir, [
        {
          type: 'skill',
          skill: { name: 'hello', description: 'A skill', path: join(sourceDir, 'a/skills/hello') },
        },
        {
          type: 'skill',
          skill: { name: 'hello', description: 'B skill', path: join(sourceDir, 'b/skills/hello') },
        },
      ])
    ).toThrow(
      [
        'Duplicate skill selected: hello',
        'Choose one source:',
        '  a/skills/hello',
        '  b/skills/hello',
      ].join('\n')
    );

    expect(() =>
      assertNoDuplicateNames(sourceDir, [
        {
          type: 'mcp',
          server: {
            name: 'confluence',
            transport: 'http',
            url: 'https://one.test',
            sourcePath: 'docker/devbox/opencode.json',
          },
        },
        {
          type: 'mcp',
          server: {
            name: 'confluence',
            transport: 'http',
            url: 'https://two.test',
            sourcePath: 'plugins/integrations/.mcp.json',
          },
        },
      ])
    ).toThrow(
      [
        'Duplicate MCP selected: confluence',
        'Choose one source:',
        '  docker/devbox/opencode.json',
        '  plugins/integrations/.mcp.json',
      ].join('\n')
    );
  });

  it('omits duplicate names from the generated install command and prints an ambiguity note', async () => {
    for (const dir of ['plugins/a/skills/hello', 'plugins/b/skills/hello', 'skills/alpha']) {
      mkdirSync(join(sourceDir, dir), { recursive: true });
    }
    writeFileSync(
      join(sourceDir, 'plugins/a/skills/hello/SKILL.md'),
      `---
name: hello
description: First hello
---
# hello
`
    );
    writeFileSync(
      join(sourceDir, 'plugins/b/skills/hello/SKILL.md'),
      `---
name: hello
description: Second hello
---
# hello
`
    );
    writeFileSync(
      join(sourceDir, 'skills/alpha/SKILL.md'),
      `---
name: alpha
description: Unique alpha
---
# alpha
`
    );
    mkdirSync(join(sourceDir, 'docker/devbox'), { recursive: true });
    mkdirSync(join(sourceDir, 'plugins/integrations'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'docker/devbox/opencode.json'),
      JSON.stringify({
        mcp: {
          confluence: { url: 'https://one.test' },
          datachat: { url: 'https://datachat.test' },
        },
      })
    );
    writeFileSync(
      join(sourceDir, 'plugins/integrations/.mcp.json'),
      JSON.stringify({ mcpServers: { confluence: { url: 'https://two.test' } } })
    );

    const { runDiscover } = await import('./discover.ts');

    await runDiscover(['https://example.com/acme/repo.git']);

    const output = logs.join('\n');
    expect(output).toContain('hello - plugins/a/skills/hello - First hello');
    expect(output).toContain('hello - plugins/b/skills/hello - Second hello');
    expect(output).toContain('confluence - docker/devbox/opencode.json - https://one.test');
    expect(output).toContain('confluence - plugins/integrations/.mcp.json - https://two.test');
    expect(output).toContain(
      'agentart install https://example.com/acme/repo.git --scope local --agents all --skills alpha --mcps datachat'
    );
    expect(output).toContain(
      'Some artifacts have duplicate names and require interactive selection:'
    );
    expect(output).toContain('  skill: hello');
    expect(output).toContain('  mcp: confluence');
    expect(output).not.toContain('--skills alpha,hello');
    expect(output).not.toContain('--mcps confluence');
  });

  it('stops the clone spinner when cloning fails', async () => {
    const git = await import('./git.ts');
    vi.mocked(git.cloneRepo).mockRejectedValueOnce(new Error('clone failed'));

    const { runDiscover } = await import('./discover.ts');

    await expect(runDiscover(['https://example.com/acme/repo.git'])).rejects.toThrow(
      'clone failed'
    );
    expect(spinnerStop).toHaveBeenCalledWith('Failed to clone repository', 1);
  });
});
