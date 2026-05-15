import { describe, expect, it } from 'vitest';
import { buildClaudePluginCommand } from './plugin-agents.ts';

describe('plugin agent adapters', () => {
  it('builds Claude marketplace and install commands', () => {
    expect(buildClaudePluginCommand('marketplace-add', 'owner/repo', 'global')).toEqual([
      'plugin',
      'marketplace',
      'add',
      'owner/repo',
      '--scope',
      'user',
    ]);
    expect(buildClaudePluginCommand('install', 'plugin@marketplace', 'project')).toEqual([
      'plugin',
      'install',
      'plugin@marketplace',
      '--scope',
      'project',
    ]);
    expect(buildClaudePluginCommand('uninstall', 'plugin', 'project')).toEqual([
      'plugin',
      'uninstall',
      'plugin',
      '--scope',
      'project',
    ]);
    expect(buildClaudePluginCommand('marketplace-list', undefined, 'project')).toEqual([
      'plugin',
      'marketplace',
      'list',
      '--json',
    ]);
  });
});
