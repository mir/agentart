/**
 * Tests for XDG config path handling (cross-platform).
 *
 * These tests verify that agents using XDG Base Directory specification
 * (OpenCode) use ~/.config paths consistently across all platforms,
 * NOT platform-specific paths like ~/Library/Preferences on macOS.
 *
 * This is critical because OpenCode follows XDG_CONFIG_HOME and falls back to
 * ~/.config, regardless of platform.
 * The sloprider CLI must match this behavior to install skills in the correct location.
 *
 * See: https://github.com/mir/sloprider/pull/66
 * See: https://github.com/mir/sloprider/issues/63
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { agents } from '../src/core/agents.ts';

describe('XDG config paths', () => {
  const home = homedir();

  describe('OpenCode', () => {
    it('uses ~/.config/opencode/skills for global skills (not ~/Library/Preferences)', () => {
      const expected = join(home, '.config', 'opencode', 'skills');
      expect(agents.opencode.globalSkillsDir).toBe(expected);
    });

    it('does NOT use platform-specific paths like ~/Library/Preferences', () => {
      expect(agents.opencode.globalSkillsDir).not.toContain('Library');
      expect(agents.opencode.globalSkillsDir).not.toContain('Preferences');
      expect(agents.opencode.globalSkillsDir).not.toContain('AppData');
    });
  });

  describe('skill lock file path', () => {
    function getSkillLockPath(xdgStateHome: string | undefined, homeDir: string): string {
      if (xdgStateHome) {
        return join(xdgStateHome, 'sloprider', '.skill-lock.json');
      }
      return join(homeDir, '.agents', '.skill-lock.json');
    }

    it('uses XDG_STATE_HOME when set', () => {
      const result = getSkillLockPath('/custom/state', home);
      expect(result).toBe(join('/custom/state', 'sloprider', '.skill-lock.json'));
    });

    it('falls back to ~/.agents when XDG_STATE_HOME is not set', () => {
      const result = getSkillLockPath(undefined, home);
      expect(result).toBe(join(home, '.agents', '.skill-lock.json'));
    });
  });

  describe('non-XDG agents', () => {
    it('cursor uses ~/.cursor/skills (home-based, not XDG)', () => {
      const expected = join(home, '.cursor', 'skills');
      expect(agents.cursor.globalSkillsDir).toBe(expected);
    });

    it('pi uses ~/.pi/agent/skills (home-based, not XDG)', () => {
      const expected = join(home, '.pi', 'agent', 'skills');
      expect(agents.pi.globalSkillsDir).toBe(expected);
    });
  });
});
