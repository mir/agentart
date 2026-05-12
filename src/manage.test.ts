import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
});
