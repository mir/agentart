import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli } from './test-utils.ts';

describe('remove command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'agentart-remove-test-'));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('removes a skill by type and name', () => {
    const skillDir = join(testDir, '.agents', 'skills', 'test-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: Test skill
---
# Test Skill
`
    );

    const result = runCli(['remove', 'skill', 'test-skill'], testDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(skillDir)).toBe(false);
  });

  it('removes an MCP server by type and name', () => {
    const configPath = join(testDir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { context7: { command: 'node', args: ['server.js'] } } })
    );

    const result = runCli(['remove', 'mcp', 'context7'], testDir);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).not.toContain('context7');
  });

  it('rejects legacy remove shape', () => {
    const result = runCli(['remove', 'test-skill'], testDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('Usage: agentart remove skill <name>');
  });
});
