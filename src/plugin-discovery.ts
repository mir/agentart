import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import {
  normalizeRepoRelativePath,
  repoPathMatchesSuffix,
  scanRepoForPathMatches,
} from './repo-scan.ts';
import type { DiscoveredPlugin, PluginSourceDescriptor } from './types.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function hashPluginManifest(path?: string): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return undefined;
  }
}

function pluginFromManifest(
  basePath: string,
  fullPath: string,
  relPath: string,
  manifest: Record<string, unknown>
): DiscoveredPlugin {
  const manifestDir = dirname(fullPath);
  const pluginRoot =
    basename(manifestDir) === '.codex-plugin' || basename(manifestDir) === '.claude-plugin'
      ? dirname(manifestDir)
      : manifestDir;
  const pluginDir = normalizeRepoRelativePath(relative(basePath, pluginRoot)) || '.';
  const name = stringValue(manifest.name) ?? basename(pluginRoot);
  return {
    name,
    version: stringValue(manifest.version),
    description: stringValue(manifest.description),
    category: stringValue(manifest.category) ?? 'Productivity',
    sourcePath: pluginDir,
    manifestPath: relPath,
    source: { source: 'local', path: pluginDir === '.' ? '.' : `./${pluginDir}` },
  };
}

function pluginSourceFromMarketplace(
  basePath: string,
  entry: Record<string, unknown>
): {
  sourcePath: string;
  source: PluginSourceDescriptor;
} | null {
  const source = entry.source;
  if (typeof source === 'string') {
    const clean = normalizeRepoRelativePath(source.replace(/^\.\//, ''));
    return { sourcePath: clean || '.', source: { source: 'local', path: source } };
  }
  if (isObject(source)) {
    if (source.source === 'local' && typeof source.path === 'string') {
      const clean = normalizeRepoRelativePath(source.path.replace(/^\.\//, ''));
      return { sourcePath: clean || '.', source: { source: 'local', path: source.path } };
    }
    if (
      source.source === 'git-subdir' &&
      typeof source.url === 'string' &&
      typeof source.path === 'string'
    ) {
      return {
        sourcePath: normalizeRepoRelativePath(source.path.replace(/^\.\//, '')),
        source: {
          source: 'git-subdir',
          url: source.url,
          path: source.path,
          ref: stringValue(source.ref),
        },
      };
    }
  }
  return {
    sourcePath: '.',
    source: {
      source: 'local',
      path: `./${normalizeRepoRelativePath(relative(basePath, basePath))}`,
    },
  };
}

function pluginsFromMarketplace(
  basePath: string,
  relPath: string,
  manifest: Record<string, unknown>
): DiscoveredPlugin[] {
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  return plugins.flatMap((entry): DiscoveredPlugin[] => {
    if (!isObject(entry)) return [];
    const name = stringValue(entry.name);
    if (!name) return [];
    const source = pluginSourceFromMarketplace(basePath, entry);
    if (!source) return [];
    return [
      {
        name,
        version: stringValue(entry.version),
        description: stringValue(entry.description),
        category: stringValue(entry.category) ?? 'Productivity',
        sourcePath: source.sourcePath,
        marketplaceName: stringValue(manifest.name),
        marketplacePath: relPath,
        source: source.source,
      },
    ];
  });
}

export async function discoverPlugins(basePath: string): Promise<DiscoveredPlugin[]> {
  const paths = await scanRepoForPathMatches(basePath, ({ relPath }) => {
    return (
      repoPathMatchesSuffix(relPath, '.codex-plugin/plugin.json') ||
      repoPathMatchesSuffix(relPath, '.claude-plugin/plugin.json') ||
      repoPathMatchesSuffix(relPath, '.agents/plugins/marketplace.json') ||
      repoPathMatchesSuffix(relPath, '.claude-plugin/marketplace.json')
    );
  });

  const discovered: DiscoveredPlugin[] = [];
  for (const fullPath of paths) {
    const relPath = normalizeRepoRelativePath(relative(basePath, fullPath));
    const manifest = await readJson(fullPath);
    if (!manifest) continue;
    if (relPath.endsWith('/marketplace.json') || relPath === '.claude-plugin/marketplace.json') {
      discovered.push(...pluginsFromMarketplace(basePath, relPath, manifest));
    } else {
      discovered.push(pluginFromManifest(basePath, fullPath, relPath, manifest));
    }
  }

  const byName = new Map<string, DiscoveredPlugin>();
  for (const plugin of discovered) {
    const key = `${plugin.name.toLowerCase()}:${plugin.sourcePath}`;
    if (!byName.has(key)) byName.set(key, plugin);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
