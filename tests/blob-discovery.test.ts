import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSkillMdPaths, tryBlobInstall, type RepoTree } from '../src/artifacts/skills.ts';

function tree(paths: string[]): RepoTree {
  return {
    sha: 'root',
    branch: 'main',
    tree: paths.map((path) => ({ path, type: 'blob', sha: path })),
  };
}

describe('blob skill discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns all SKILL.md paths through depth 10 with priority ordering', () => {
    const repoTree = tree([
      'z/other/SKILL.md',
      'skills/priority/SKILL.md',
      'd0/d1/d2/d3/d4/d5/d6/d7/d8/d9/SKILL.md',
      'd0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/SKILL.md',
      'node_modules/pkg/SKILL.md',
      'build/generated/SKILL.md',
    ]);

    expect(findSkillMdPaths(repoTree)).toEqual([
      'skills/priority/SKILL.md',
      'd0/d1/d2/d3/d4/d5/d6/d7/d8/d9/SKILL.md',
      'z/other/SKILL.md',
    ]);
  });

  it('preserves direct subpath single-skill behavior', () => {
    const repoTree = tree(['skills/parent/SKILL.md', 'skills/parent/children/child/SKILL.md']);

    expect(findSkillMdPaths(repoTree, 'skills/parent')).toEqual(['skills/parent/SKILL.md']);
  });

  it('falls back to parent folder name when blob SKILL.md has no name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);

        if (url.includes('/repos/acme/repo/git/trees/HEAD')) {
          return new Response(
            JSON.stringify({
              sha: 'root',
              tree: [
                {
                  path: 'plugins/semrush-context/skills/daily-briefing/SKILL.md',
                  type: 'blob',
                  sha: 'skill',
                },
              ],
            }),
            { status: 200 }
          );
        }

        if (
          url ===
          'https://raw.githubusercontent.com/acme/repo/HEAD/plugins/semrush-context/skills/daily-briefing/SKILL.md'
        ) {
          return new Response(
            `---
description: Daily briefing skill
---

# Daily Briefing
`,
            { status: 200 }
          );
        }

        if (url === 'https://skills.sh/api/download/acme/repo/daily-briefing') {
          return new Response(
            JSON.stringify({
              files: [{ path: 'SKILL.md', contents: '# Daily Briefing\n' }],
              hash: 'snapshot',
            }),
            { status: 200 }
          );
        }

        return new Response('', { status: 404 });
      })
    );

    const result = await tryBlobInstall('acme/repo');

    expect(result?.skills).toHaveLength(1);
    expect(result?.skills[0]?.name).toBe('daily-briefing');
    expect(result?.skills[0]?.description).toBe('Daily briefing skill');
  });
});
