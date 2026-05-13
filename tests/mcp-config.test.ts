import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installMcpServerForAgent,
  listMcpServersForAgent,
  removeMcpServerForAgent,
} from '../src/mcp-config.ts';
import { discoverMcpServers } from '../src/mcp-discovery.ts';

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentart-mcp-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('MCP config', () => {
  it('writes and removes mcpServers JSON while preserving other keys', async () => {
    await withTempDir(async (cwd) => {
      const path = join(cwd, '.cursor/mcp.json');
      await mkdir(join(cwd, '.cursor'), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ note: 'keep', mcpServers: { old: { command: 'old' } } })
      );

      await installMcpServerForAgent(
        {
          name: 'context7',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
        },
        'cursor',
        { cwd }
      );

      const parsed = JSON.parse(await readFile(path, 'utf-8'));
      expect(parsed.note).toBe('keep');
      expect(parsed.mcpServers.old.command).toBe('old');
      expect(parsed.mcpServers.context7).toEqual({
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      });

      const listed = await listMcpServersForAgent('cursor', { cwd });
      expect(listed.map((server) => server.name).sort()).toEqual(['context7', 'old']);

      await removeMcpServerForAgent('context7', 'cursor', { cwd });
      const afterRemove = JSON.parse(await readFile(path, 'utf-8'));
      expect(afterRemove.mcpServers.context7).toBeUndefined();
      expect(afterRemove.mcpServers.old.command).toBe('old');
    });
  });

  it('writes Codex TOML blocks without removing unrelated config', async () => {
    await withTempDir(async (cwd) => {
      const path = join(cwd, '.codex/config.toml');
      await mkdir(join(cwd, '.codex'), { recursive: true });
      await writeFile(path, 'model = "gpt-5"\n\n[mcp_servers.old]\ncommand = "old"\n');

      await installMcpServerForAgent(
        {
          name: 'context7',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
        },
        'codex',
        { cwd }
      );

      const content = await readFile(path, 'utf-8');
      expect(content).toContain('model = "gpt-5"');
      expect(content).toContain('[mcp_servers.old]');
      expect(content).toContain('[mcp_servers."context7"]');
      expect(content).toContain('args = ["-y", "@upstash/context7-mcp"]');

      const listed = await listMcpServersForAgent('codex', { cwd });
      expect(listed.map((server) => server.name).sort()).toEqual(['context7', 'old']);
      expect(listed.find((server) => server.name === 'context7')?.args).toEqual([
        '-y',
        '@upstash/context7-mcp',
      ]);

      await removeMcpServerForAgent('context7', 'codex', { cwd });
      const afterRemove = await readFile(path, 'utf-8');
      expect(afterRemove).toContain('model = "gpt-5"');
      expect(afterRemove).toContain('[mcp_servers.old]');
      expect(afterRemove).not.toContain('[mcp_servers."context7"]');
    });
  });

  it('discovers MCP servers from supported project config files', async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        join(cwd, '.mcp.json'),
        JSON.stringify({ mcpServers: { claude: { command: 'node', args: ['server.js'] } } })
      );

      await writeFile(
        join(cwd, 'agentart-mcp-lock.json'),
        JSON.stringify({
          version: 1,
          mcps: { locked: { server: { command: 'npx', args: ['locked'] } } },
        })
      );

      await writeFile(
        join(cwd, 'opencode.jsonc'),
        `{
          // jsonc is accepted
          "mcp": { "open": { "url": "https://example.com/mcp" } },
        }`
      );

      await mkdir(join(cwd, '.cursor'), { recursive: true });
      await writeFile(
        join(cwd, '.cursor/mcp.json'),
        JSON.stringify({ mcpServers: { cursor: { command: 'cursor-mcp' } } })
      );

      await mkdir(join(cwd, '.vscode'), { recursive: true });
      await writeFile(
        join(cwd, '.vscode/mcp.json'),
        JSON.stringify({ servers: { vscode: { command: 'vscode-mcp' } } })
      );

      await mkdir(join(cwd, '.gemini'), { recursive: true });
      await writeFile(
        join(cwd, '.gemini/settings.json'),
        JSON.stringify({ mcpServers: { gemini: { command: 'gemini-mcp' } } })
      );

      await mkdir(join(cwd, '.codex'), { recursive: true });
      await writeFile(
        join(cwd, '.codex/config.toml'),
        '[mcp_servers.codex]\ncommand = "codex-mcp"\n'
      );

      await mkdir(join(cwd, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(cwd, '.claude-plugin/plugin.json'),
        JSON.stringify({ mcpServers: { plugin: { command: 'plugin-mcp' } } })
      );

      const discovered = await discoverMcpServers(cwd);
      expect(discovered.map((server) => server.name).sort()).toEqual([
        'claude',
        'codex',
        'cursor',
        'gemini',
        'locked',
        'open',
        'plugin',
        'vscode',
      ]);
    });
  });

  it('discovers MCP servers from nested supported config paths', async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, 'plugins/semrush-context'), { recursive: true });
      await writeFile(
        join(cwd, 'plugins/semrush-context/.mcp.json'),
        JSON.stringify({ mcpServers: { semrush: { command: 'semrush-mcp' } } })
      );

      await mkdir(join(cwd, 'plugins/foo/.vscode'), { recursive: true });
      await writeFile(
        join(cwd, 'plugins/foo/.vscode/mcp.json'),
        JSON.stringify({ servers: { nestedVscode: { command: 'vscode-mcp' } } })
      );

      const discovered = await discoverMcpServers(cwd);
      expect(discovered).toMatchObject([
        {
          name: 'nestedVscode',
          sourcePath: 'plugins/foo/.vscode/mcp.json',
        },
        {
          name: 'semrush',
          sourcePath: 'plugins/semrush-context/.mcp.json',
        },
      ]);
    });
  });

  it('does not treat Claude or OpenCode settings.json as MCP definition files', async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(
        join(cwd, '.claude/settings.json'),
        JSON.stringify({ mcpServers: { claudeSettings: { command: 'bad' } } })
      );

      await mkdir(join(cwd, '.opencode'), { recursive: true });
      await writeFile(
        join(cwd, '.opencode/settings.json'),
        JSON.stringify({ mcp: { opencodeSettings: { command: 'bad' } } })
      );

      await mkdir(join(cwd, 'plugins/foo'), { recursive: true });
      await writeFile(
        join(cwd, 'plugins/foo/settings.json'),
        JSON.stringify({ mcpServers: { randomSettings: { command: 'bad' } } })
      );
      await writeFile(
        join(cwd, 'plugins/foo/plugin.json'),
        JSON.stringify({ mcpServers: { randomPlugin: { command: 'bad' } } })
      );

      expect(await discoverMcpServers(cwd)).toEqual([]);
    });
  });
});
