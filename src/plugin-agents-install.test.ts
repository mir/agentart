import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginCatalogItem } from './core/artifacts.ts';

describe('Claude plugin installation', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('updates a stale marketplace and retries once when Claude cannot find a discovered plugin', async () => {
    const staleError = new Error(
      'Command failed: claude plugin install hide-secrets@agent-marketplace --scope project\n' +
        'Failed to install plugin "hide-secrets@agent-marketplace": Plugin "hide-secrets" not found in marketplace "agent-marketplace". Your local copy may be out of date — try `claude plugin marketplace update agent-marketplace`.'
    );
    const outcomes: Array<Error | null> = [staleError, null, null];
    const execFile = vi.fn((command: string, args: string[], callback: any) => {
      const outcome = outcomes.shift();
      callback(outcome, '', '');
    });
    vi.doMock('child_process', () => ({ execFile }));

    const { installPluginForAgent } = await import('./artifacts/plugins.ts');
    const plugin: PluginCatalogItem = {
      name: 'hide-secrets',
      marketplaceName: 'agent-marketplace',
      configPath: './plugins/hide-secrets',
      source: { source: 'local', path: './plugins/hide-secrets' },
    };

    await expect(
      installPluginForAgent(plugin, 'claude-code', 'project', 'INSTALLED_BY_DEFAULT')
    ).resolves.toEqual({ success: true });

    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile.mock.calls.map(([, args]) => args)).toEqual([
      ['plugin', 'install', 'hide-secrets@agent-marketplace', '--scope', 'project'],
      ['plugin', 'marketplace', 'update', 'agent-marketplace'],
      ['plugin', 'install', 'hide-secrets@agent-marketplace', '--scope', 'project'],
    ]);
  });
});
