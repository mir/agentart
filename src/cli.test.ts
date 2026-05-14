import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hasLogo, runCli, runCliOutput } from './test-utils.ts';

describe('agentart CLI', () => {
  it('prints R2 help', () => {
    const output = runCliOutput(['--help']);
    expect(output).toContain('Usage: agentart [command]');
    expect(output).toContain('discover <git-url>');
    expect(output).toContain('install <git-url>');
    expect(output).toContain('mcp add <url>');
    expect(output).toContain('remove skill <name>');
    expect(output).toContain('remove mcp <name>');
    expect(output).toContain('remove hook <name>');
    expect(output).toContain('manage');
    expect(output).not.toContain('agentart add');
  });

  it('prints version from package.json', () => {
    const output = runCliOutput(['--version']);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'));
    expect(output.trim()).toBe(pkg.version);
  });

  it('starts manage with no arguments', () => {
    const output = runCliOutput([]);
    expect(hasLogo(output)).toBe(true);
    expect(output).toContain('agentart manage');
    expect(output).toContain('What do you want to do?');
  });

  it('keeps logo off list and remove errors', () => {
    expect(hasLogo(runCliOutput(['list']))).toBe(false);
    expect(hasLogo(runCliOutput(['remove']))).toBe(false);
  });

  it('rejects legacy commands', () => {
    for (const command of ['add', 'update', 'check', 'ls', 'rm']) {
      expect(runCliOutput([command])).toContain(`Unknown command: ${command}`);
    }
  });

  it('prints mcp add usage for unsupported mcp subcommands', () => {
    const noSubcommand = runCli(['mcp']);
    expect(noSubcommand.stdout + noSubcommand.stderr).toContain('Usage: agentart mcp add <url>');

    const unsupported = runCli(['mcp', 'remove']);
    expect(unsupported.stdout + unsupported.stderr).toContain('Usage: agentart mcp add <url>');
  });

  it('prints friendly unsupported source errors without a Bun stack trace', () => {
    const result = runCli(['discover', 'https://mintlify.com/docs']);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).toContain('Unsupported git repository source: https://mintlify.com/docs');
    expect(output).toContain('Provide a git repository link in one of these formats:');
    expect(output).toContain('https://gitlab.example.com/group/repo/-/blob/main/path/file');
    expect(output).not.toContain('at unsupportedSource');
    expect(output).not.toContain('Bun v');
  });
});
