import { readFile } from 'fs/promises';
import { join, resolve, normalize, sep } from 'path';
function isContainedIn(installedPath: string, basePath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(installedPath));
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}
function isValidRelativePath(path: string): boolean {
  return path.startsWith('./');
}
interface PluginManifestEntry {
  source?: string | { source: string; repo?: string };
  skills?: string[];
  name?: string;
}
interface MarketplaceManifest {
  metadata?: { pluginRoot?: string };
  plugins?: PluginManifestEntry[];
}
interface PluginManifest {
  skills?: string[];
  name?: string;
}
export async function getPluginSkillPaths(basePath: string): Promise<string[]> {
  const searchDirs: string[] = [];
  const addPluginSkillPaths = (pluginBase: string, skills?: string[]) => {
    if (!isContainedIn(pluginBase, basePath)) return;
    if (skills && skills.length > 0) {
      for (const skillPath of skills) {
        if (!isValidRelativePath(skillPath)) continue;
        const skillDir = join(pluginBase, skillPath);
        if (isContainedIn(skillDir, basePath)) {
          searchDirs.push(skillDir);
        }
      }
    }
    searchDirs.push(join(pluginBase, 'skills'));
  };
  try {
    const content = await readFile(join(basePath, '.claude-plugin/marketplace.json'), 'utf-8');
    const manifest: MarketplaceManifest = JSON.parse(content);
    const pluginRoot = manifest.metadata?.pluginRoot;
    const validPluginRoot = pluginRoot === undefined || isValidRelativePath(pluginRoot);
    if (validPluginRoot) {
      for (const plugin of manifest.plugins ?? []) {
        if (typeof plugin.source !== 'string' && plugin.source !== undefined) continue;
        if (plugin.source !== undefined && !isValidRelativePath(plugin.source)) continue;
        const pluginBase = join(basePath, pluginRoot ?? '', plugin.source ?? '');
        addPluginSkillPaths(pluginBase, plugin.skills);
      }
    }
  } catch {}
  try {
    const content = await readFile(join(basePath, '.claude-plugin/plugin.json'), 'utf-8');
    const manifest: PluginManifest = JSON.parse(content);
    addPluginSkillPaths(basePath, manifest.skills);
  } catch {}
  return searchDirs;
}
export async function getPluginGroupings(basePath: string): Promise<Map<string, string>> {
  const groupings = new Map<string, string>();
  try {
    const content = await readFile(join(basePath, '.claude-plugin/marketplace.json'), 'utf-8');
    const manifest: MarketplaceManifest = JSON.parse(content);
    const pluginRoot = manifest.metadata?.pluginRoot;
    const validPluginRoot = pluginRoot === undefined || isValidRelativePath(pluginRoot);
    if (validPluginRoot) {
      for (const plugin of manifest.plugins ?? []) {
        if (!plugin.name) continue;
        if (typeof plugin.source !== 'string' && plugin.source !== undefined) continue;
        if (plugin.source !== undefined && !isValidRelativePath(plugin.source)) continue;
        const pluginBase = join(basePath, pluginRoot ?? '', plugin.source ?? '');
        if (!isContainedIn(pluginBase, basePath)) continue;
        if (plugin.skills && plugin.skills.length > 0) {
          for (const skillPath of plugin.skills) {
            if (!isValidRelativePath(skillPath)) continue;
            const skillDir = join(pluginBase, skillPath);
            if (isContainedIn(skillDir, basePath)) {
              groupings.set(resolve(skillDir), plugin.name);
            }
          }
        }
      }
    }
  } catch {}
  try {
    const content = await readFile(join(basePath, '.claude-plugin/plugin.json'), 'utf-8');
    const manifest: PluginManifest = JSON.parse(content);
    if (manifest.name && manifest.skills && manifest.skills.length > 0) {
      for (const skillPath of manifest.skills) {
        if (!isValidRelativePath(skillPath)) continue;
        const skillDir = join(basePath, skillPath);
        if (isContainedIn(skillDir, basePath)) {
          groupings.set(resolve(skillDir), manifest.name);
        }
      }
    }
  } catch {}
  return groupings;
}
