import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runCliOutput, stripLogo, hasLogo } from './test-utils.ts';

describe('agentart CLI', () => {
  describe('--help', () => {
    it('should display help message', () => {
      const output = runCliOutput(['--help']);
      expect(output).toContain('Usage: agentart <command> [options]');
      expect(output).toContain('Manage Skills:');
      expect(output).not.toContain('init [name]');
      expect(output).not.toContain('experimental_install');
      expect(output).not.toContain('experimental_sync');
      expect(output).toContain('add <url>');
      expect(output).toContain('update');
      expect(output).toContain('aliases: check, upgrade');
      expect(output).not.toMatch(/find\s+\[query\]/);
      expect(output).not.toMatch(/agentart\s+find/);
      expect(output).toContain('Add Options:');
      expect(output).toContain('-g, --global');
      expect(output).toContain('-a, --agent');
      expect(output).toContain('-s, --skill');
      expect(output).toContain('--mcp');
      expect(output).toContain('--no-mcp');
      expect(output).toContain('-l, --list');
      expect(output).toContain('-y, --yes');
      expect(output).toContain('--all');
    });

    it('should show same output for -h alias', () => {
      const helpOutput = runCliOutput(['--help']);
      const hOutput = runCliOutput(['-h']);
      expect(hOutput).toBe(helpOutput);
    });
  });

  describe('--version', () => {
    it('should display version number', () => {
      const output = runCliOutput(['--version']);
      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should match package.json version', () => {
      const output = runCliOutput(['--version']);
      const pkg = JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')
      );
      expect(output.trim()).toBe(pkg.version);
    });
  });

  describe('no arguments', () => {
    it('should display banner', () => {
      const output = stripLogo(runCliOutput([]));
      expect(output).toContain('Agentart: the open agent MCP and skills ecosystem');
      expect(output).toContain('agentart add');
      expect(output).toContain('agentart update');
      expect(output).toContain('agentart mcp');
      expect(output).not.toContain('agentart init');
      expect(output).not.toContain('agentart experimental_install');
      expect(output).not.toContain('agentart experimental_sync');
      expect(output).not.toMatch(/agentart\s+find/);
    });
  });

  describe('unknown command', () => {
    it('should show error for unknown command', () => {
      const output = runCliOutput(['unknown-command']);
      expect(output).toMatchInlineSnapshot(`
        "Unknown command: unknown-command
        Run agentart --help for usage.
        "
      `);
    });

    it.each(['find', 'search', 'f', 's', 'init', 'experimental_install', 'experimental_sync'])(
      'should show error for removed %s command',
      (command) => {
        const output = runCliOutput([command]);
        expect(output).toBe(`Unknown command: ${command}\nRun agentart --help for usage.\n`);
      }
    );
  });

  describe('logo display', () => {
    it('should not display logo for list command', () => {
      const output = runCliOutput(['list']);
      expect(hasLogo(output)).toBe(false);
    });

    it('should not display logo for check command', () => {
      // Note: check command makes GitHub API calls, so we just verify initial output
      const output = runCliOutput(['check']);
      expect(hasLogo(output)).toBe(false);
    }, 60000);

    it('should not display logo for update command', () => {
      // Note: update command makes GitHub API calls, so we just verify initial output
      const output = runCliOutput(['update']);
      expect(hasLogo(output)).toBe(false);
    }, 60000);
  });
});
