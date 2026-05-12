import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli } from './test-utils.ts';
import { shouldInstallInternalSkills } from './skills.ts';
import { parseAddOptions } from './add.ts';

describe('add command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `agentart-add-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should show error when no source provided', () => {
    const result = runCli(['add'], testDir);
    expect(result.stdout).toContain('ERROR');
    expect(result.stdout).toContain('Missing required argument: source');
    expect(result.exitCode).toBe(1);
  });

  it('should show error for non-existent local path', () => {
    const result = runCli(['add', './non-existent-path', '-y'], testDir);
    expect(result.stdout).toContain('Local path does not exist');
    expect(result.exitCode).toBe(1);
  });

  it('should list skills from local path with --list flag', () => {
    // Create a test skill
    const skillDir = join(testDir, 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: A test skill for testing
---

# Test Skill

This is a test skill.
`
    );

    const result = runCli(['add', testDir, '--list'], testDir);
    expect(result.stdout).toContain('test-skill');
    expect(result.stdout).toContain('A test skill for testing');
    expect(result.exitCode).toBe(0);
  });

  it('should show no skills found for empty directory', () => {
    const result = runCli(['add', testDir, '-y'], testDir);
    expect(result.stdout).toContain('No skills found');
    expect(result.stdout).toContain('No valid skills found');
    expect(result.exitCode).toBe(1);
  });

  it('should install skill from local path with -y flag', () => {
    // Create a test skill
    const skillDir = join(testDir, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: My test skill
---

# My Skill

Instructions here.
`
    );

    // Create a target directory to install to
    const targetDir = join(testDir, 'project');
    mkdirSync(targetDir, { recursive: true });

    const result = runCli(['add', testDir, '-y', '-g', '--agent', 'claude-code'], targetDir);
    expect(result.stdout).toContain('my-skill');
    expect(result.stdout).toContain('Done!');
    expect(result.exitCode).toBe(0);
  });

  it('should install discovered MCP servers from local path when requested', () => {
    const sourceDir = join(testDir, 'source');
    const targetDir = join(testDir, 'project');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(sourceDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: { command: 'node', args: ['server.js'] },
        },
      })
    );

    const result = runCli(['add', sourceDir, '--mcp', '*', '-y', '--agent', 'codex'], targetDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed 1 MCP server');
    expect(readFileSync(join(targetDir, '.codex', 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers."docs"]'
    );

    const lock = JSON.parse(readFileSync(join(targetDir, 'agentart-mcp-lock.json'), 'utf-8'));
    expect(lock.mcps.docs.server).toEqual({
      name: 'docs',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(lock.mcps.docs.sourceType).toBe('local');
  });

  it('should not install discovered MCP servers in non-interactive mode without --mcp', () => {
    const sourceDir = join(testDir, 'source');
    const targetDir = join(testDir, 'project');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(sourceDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: { command: 'node', args: ['server.js'] },
        },
      })
    );

    const result = runCli(['add', sourceDir, '-y', '--agent', 'codex'], targetDir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Pass --mcp '*'");
    expect(existsSync(join(targetDir, '.codex', 'config.toml'))).toBe(false);
  });

  it('should skip MCP installation when --no-mcp is provided', () => {
    const sourceDir = join(testDir, 'source');
    const targetDir = join(testDir, 'project');
    const skillDir = join(sourceDir, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: My test skill
---
# My Skill
`
    );
    writeFileSync(
      join(sourceDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          docs: { command: 'node', args: ['server.js'] },
        },
      })
    );

    const result = runCli(['add', sourceDir, '--no-mcp', '-y', '--agent', 'codex'], targetDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed 1 skill');
    expect(existsSync(join(targetDir, '.codex', 'config.toml'))).toBe(false);
  });

  it('should write agentart provenance metadata into installed skills', () => {
    const skillDir = join(testDir, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: My test skill
metadata:
  author: example-org
  version: "1.0"
---

# My Skill
`
    );

    const targetDir = join(testDir, 'project');
    mkdirSync(targetDir, { recursive: true });

    const result = runCli(['add', testDir, '-y', '--agent', 'codex'], targetDir);
    expect(result.exitCode).toBe(0);

    const installed = readFileSync(
      join(targetDir, '.agents', 'skills', 'my-skill', 'SKILL.md'),
      'utf-8'
    );
    expect(installed).toContain('  author: example-org\n');
    expect(installed).toContain('  version: "1.0"\n');
    expect(installed).toContain('  sourceType: "local"\n');
    expect(installed).toContain('  agentart: "https://github.com/vercel-labs/agentart"\n');
    expect(installed).toContain('  updateCommand: "agentart add ');
  });

  it('should filter skills by name with --skill flag', () => {
    // Create multiple test skills
    const skill1Dir = join(testDir, 'skills', 'skill-one');
    const skill2Dir = join(testDir, 'skills', 'skill-two');
    mkdirSync(skill1Dir, { recursive: true });
    mkdirSync(skill2Dir, { recursive: true });

    writeFileSync(
      join(skill1Dir, 'SKILL.md'),
      `---
name: skill-one
description: First skill
---
# Skill One
`
    );

    writeFileSync(
      join(skill2Dir, 'SKILL.md'),
      `---
name: skill-two
description: Second skill
---
# Skill Two
`
    );

    const result = runCli(['add', testDir, '--list', '--skill', 'skill-one'], testDir);
    // With --list, it should show only the filtered skill info
    expect(result.stdout).toContain('skill-one');
  });

  it('should show error for invalid agent name', () => {
    // Create a test skill
    const skillDir = join(testDir, 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: Test
---
# Test
`
    );

    const result = runCli(['add', testDir, '-y', '--agent', 'invalid-agent'], testDir);
    expect(result.stdout).toContain('Invalid agents');
    expect(result.exitCode).toBe(1);
  });

  it('should support add command aliases (a, i, install)', () => {
    // Test that aliases work (just check they show missing source error)
    const resultA = runCli(['a'], testDir);
    const resultI = runCli(['i'], testDir);
    const resultInstall = runCli(['install'], testDir);

    // All should show the same "missing source" error
    expect(resultA.stdout).toContain('Missing required argument: source');
    expect(resultI.stdout).toContain('Missing required argument: source');
    expect(resultInstall.stdout).toContain('Missing required argument: source');
  });

  describe('internal skills', () => {
    it('should skip internal skills by default', () => {
      // Create an internal skill
      const skillDir = join(testDir, 'internal-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: internal-skill
description: An internal skill
metadata:
  internal: true
---

# Internal Skill

This is an internal skill.
`
      );

      const result = runCli(['add', testDir, '--list'], testDir);
      expect(result.stdout).not.toContain('internal-skill');
    });

    it('should show internal skills when INSTALL_INTERNAL_SKILLS=1', () => {
      // Create an internal skill
      const skillDir = join(testDir, 'internal-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: internal-skill
description: An internal skill
metadata:
  internal: true
---

# Internal Skill

This is an internal skill.
`
      );

      const result = runCli(['add', testDir, '--list'], testDir, {
        INSTALL_INTERNAL_SKILLS: '1',
      });
      expect(result.stdout).toContain('internal-skill');
      expect(result.stdout).toContain('An internal skill');
    });

    it('should show internal skills when INSTALL_INTERNAL_SKILLS=true', () => {
      // Create an internal skill
      const skillDir = join(testDir, 'internal-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: internal-skill
description: An internal skill
metadata:
  internal: true
---

# Internal Skill

This is an internal skill.
`
      );

      const result = runCli(['add', testDir, '--list'], testDir, {
        INSTALL_INTERNAL_SKILLS: 'true',
      });
      expect(result.stdout).toContain('internal-skill');
    });

    it('should show non-internal skills alongside internal when env var is set', () => {
      // Create both internal and non-internal skills
      const internalDir = join(testDir, 'skills', 'internal-skill');
      const publicDir = join(testDir, 'skills', 'public-skill');
      mkdirSync(internalDir, { recursive: true });
      mkdirSync(publicDir, { recursive: true });

      writeFileSync(
        join(internalDir, 'SKILL.md'),
        `---
name: internal-skill
description: An internal skill
metadata:
  internal: true
---
# Internal Skill
`
      );

      writeFileSync(
        join(publicDir, 'SKILL.md'),
        `---
name: public-skill
description: A public skill
---
# Public Skill
`
      );

      // Without env var - only public skill visible
      const resultWithout = runCli(['add', testDir, '--list'], testDir);
      expect(resultWithout.stdout).toContain('public-skill');
      expect(resultWithout.stdout).not.toContain('internal-skill');

      // With env var - both visible
      const resultWith = runCli(['add', testDir, '--list'], testDir, {
        INSTALL_INTERNAL_SKILLS: '1',
      });
      expect(resultWith.stdout).toContain('public-skill');
      expect(resultWith.stdout).toContain('internal-skill');
    });

    it('should not treat metadata.internal: false as internal', () => {
      const skillDir = join(testDir, 'not-internal-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        `---
name: not-internal-skill
description: Explicitly not internal
metadata:
  internal: false
---
# Not Internal
`
      );

      const result = runCli(['add', testDir, '--list'], testDir);
      expect(result.stdout).toContain('not-internal-skill');
    });
  });
});

describe('shouldInstallInternalSkills', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return false when INSTALL_INTERNAL_SKILLS is not set', () => {
    delete process.env.INSTALL_INTERNAL_SKILLS;
    expect(shouldInstallInternalSkills()).toBe(false);
  });

  it('should return true when INSTALL_INTERNAL_SKILLS=1', () => {
    process.env.INSTALL_INTERNAL_SKILLS = '1';
    expect(shouldInstallInternalSkills()).toBe(true);
  });

  it('should return true when INSTALL_INTERNAL_SKILLS=true', () => {
    process.env.INSTALL_INTERNAL_SKILLS = 'true';
    expect(shouldInstallInternalSkills()).toBe(true);
  });

  it('should return false for other values', () => {
    process.env.INSTALL_INTERNAL_SKILLS = '0';
    expect(shouldInstallInternalSkills()).toBe(false);

    process.env.INSTALL_INTERNAL_SKILLS = 'false';
    expect(shouldInstallInternalSkills()).toBe(false);

    process.env.INSTALL_INTERNAL_SKILLS = 'yes';
    expect(shouldInstallInternalSkills()).toBe(false);
  });
});

describe('parseAddOptions', () => {
  it('should parse --all flag', () => {
    const result = parseAddOptions(['source', '--all']);
    expect(result.source).toEqual(['source']);
    expect(result.options.all).toBe(true);
  });

  it('should parse --skill with wildcard', () => {
    const result = parseAddOptions(['source', '--skill', '*']);
    expect(result.source).toEqual(['source']);
    expect(result.options.skill).toEqual(['*']);
  });

  it('should parse --agent with wildcard', () => {
    const result = parseAddOptions(['source', '--agent', '*']);
    expect(result.source).toEqual(['source']);
    expect(result.options.agent).toEqual(['*']);
  });

  it('should parse --mcp with wildcard and names', () => {
    const wildcard = parseAddOptions(['source', '--mcp', '*']);
    expect(wildcard.source).toEqual(['source']);
    expect(wildcard.options.mcp).toEqual(['*']);

    const named = parseAddOptions(['source', '--mcp', 'docs', 'search', '--agent', 'codex']);
    expect(named.source).toEqual(['source']);
    expect(named.options.mcp).toEqual(['docs', 'search']);
    expect(named.options.agent).toEqual(['codex']);
  });

  it('should parse --no-mcp flag', () => {
    const result = parseAddOptions(['source', '--no-mcp']);
    expect(result.source).toEqual(['source']);
    expect(result.options.noMcp).toBe(true);
  });

  it('should parse --skill wildcard with specific agents', () => {
    const result = parseAddOptions(['source', '--skill', '*', '--agent', 'claude-code']);
    expect(result.source).toEqual(['source']);
    expect(result.options.skill).toEqual(['*']);
    expect(result.options.agent).toEqual(['claude-code']);
  });

  it('should parse --agent wildcard with specific skills', () => {
    const result = parseAddOptions(['source', '--agent', '*', '--skill', 'my-skill']);
    expect(result.source).toEqual(['source']);
    expect(result.options.agent).toEqual(['*']);
    expect(result.options.skill).toEqual(['my-skill']);
  });

  it('should parse combined flags with wildcards', () => {
    const result = parseAddOptions(['source', '-g', '--skill', '*', '-y']);
    expect(result.source).toEqual(['source']);
    expect(result.options.global).toBe(true);
    expect(result.options.skill).toEqual(['*']);
    expect(result.options.yes).toBe(true);
  });

  it('should parse --full-depth flag', () => {
    const result = parseAddOptions(['source', '--full-depth']);
    expect(result.source).toEqual(['source']);
    expect(result.options.fullDepth).toBe(true);
  });

  it('should parse --full-depth with other flags', () => {
    const result = parseAddOptions(['source', '--full-depth', '--list', '-g']);
    expect(result.source).toEqual(['source']);
    expect(result.options.fullDepth).toBe(true);
    expect(result.options.list).toBe(true);
    expect(result.options.global).toBe(true);
  });
});
