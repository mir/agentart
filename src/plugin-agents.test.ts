import { describe, expect, it } from 'vitest';
import {
  buildClaudePluginCommand,
  isClaudeMarketplaceOutOfDateError,
  isClaudePluginNotFoundError,
  parseClaudePluginList,
  splitClaudePluginId,
} from './plugin-agents.ts';

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
    expect(buildClaudePluginCommand('marketplace-update', 'marketplace', 'project')).toEqual([
      'plugin',
      'marketplace',
      'update',
      'marketplace',
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
    expect(buildClaudePluginCommand('list', undefined, 'project')).toEqual([
      'plugin',
      'list',
      '--json',
    ]);
  });

  it('parses Claude installed plugins', () => {
    expect(
      parseClaudePluginList(
        JSON.stringify([
          {
            id: 'context7@claude-plugins-official',
            version: 'unknown',
            scope: 'user',
            enabled: true,
            installPath: '/tmp/context7',
          },
          {
            id: 'project-plugin@demo',
            scope: 'project',
            enabled: false,
          },
          {
            id: 'ignored',
            scope: 'workspace',
          },
        ])
      )
    ).toEqual([
      {
        id: 'context7@claude-plugins-official',
        version: 'unknown',
        scope: 'global',
        enabled: true,
        installPath: '/tmp/context7',
      },
      {
        id: 'project-plugin@demo',
        version: undefined,
        scope: 'project',
        enabled: false,
        installPath: undefined,
      },
    ]);
  });

  it('detects Claude marketplace stale-cache install errors', () => {
    expect(
      isClaudeMarketplaceOutOfDateError(
        new Error(
          'Failed to install plugin "hide-secrets@agent-marketplace": Plugin "hide-secrets" not found in marketplace "agent-marketplace". Your local copy may be out of date — try `claude plugin marketplace update agent-marketplace`.'
        ),
        'hide-secrets',
        'agent-marketplace'
      )
    ).toBe(true);

    expect(
      isClaudeMarketplaceOutOfDateError(
        new Error('Plugin "other" not found in marketplace "agent-marketplace".'),
        'hide-secrets',
        'agent-marketplace'
      )
    ).toBe(false);
  });

  it('splits Claude marketplace-qualified plugin ids', () => {
    expect(splitClaudePluginId('hide-secrets@agent-marketplace')).toEqual({
      name: 'hide-secrets',
      marketplaceName: 'agent-marketplace',
    });
    expect(splitClaudePluginId('local-plugin')).toEqual({ name: 'local-plugin' });
  });

  it('detects Claude uninstall not-found errors', () => {
    expect(
      isClaudePluginNotFoundError(
        new Error(
          'Failed to uninstall plugin "hide-secrets@agent-marketplace": Plugin "hide-secrets@agent-marketplace" not found in installed plugins'
        ),
        'hide-secrets@agent-marketplace'
      )
    ).toBe(true);
  });
});
