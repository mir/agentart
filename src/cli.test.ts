import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hasLogo, runCliOutput, stripLogo } from './test-utils.ts';

describe('agentart CLI', () => {
  it('prints R2 help', () => {
    const output = runCliOutput(['--help']);
    expect(output).toContain('Usage: agentart <command>');
    expect(output).toContain('discover <git-url>');
    expect(output).toContain('remove skill <name>');
    expect(output).toContain('remove mcp <name>');
    expect(output).toContain('manage');
    expect(output).not.toContain('agentart add');
    expect(output).not.toContain('agentart mcp <command>');
  });

  it('prints version from package.json', () => {
    const output = runCliOutput(['--version']);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8'));
    expect(output.trim()).toBe(pkg.version);
  });

  it('prints the R2 banner with no arguments', () => {
    const output = stripLogo(runCliOutput([]));
    expect(output).toContain('Agentart: discover and manage agent skills and MCPs');
    expect(output).toContain('agentart discover');
    expect(output).toContain('agentart list');
    expect(output).toContain('agentart manage');
  });

  it('keeps logo off list and remove errors', () => {
    expect(hasLogo(runCliOutput(['list']))).toBe(false);
    expect(hasLogo(runCliOutput(['remove']))).toBe(false);
  });

  it('rejects legacy commands', () => {
    for (const command of ['add', 'mcp', 'update', 'check', 'ls', 'rm']) {
      expect(runCliOutput([command])).toContain(`Unknown command: ${command}`);
    }
  });
});
