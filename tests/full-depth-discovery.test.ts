/**
 * Tests for the --full-depth option in skill discovery.
 *
 * When a repository has both a root SKILL.md and nested skills in subdirectories,
 * the --full-depth flag allows discovering all skills instead of just the root one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverSkills } from '../src/artifacts/skills.ts';

describe('discoverSkills with fullDepth option', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sloprider-full-depth-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return root and nested skills by default for repo-root scans', async () => {
    // Create root SKILL.md
    writeFileSync(
      join(testDir, 'SKILL.md'),
      `---
name: root-skill
description: Root level skill
---

# Root Skill
`
    );

    // Create nested skill in skills/ directory
    mkdirSync(join(testDir, 'skills', 'nested-skill'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'nested-skill', 'SKILL.md'),
      `---
name: nested-skill
description: Nested skill
---

# Nested Skill
`
    );

    const skills = await discoverSkills(testDir, undefined, { fullDepth: false });

    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(['root-skill', 'nested-skill']);
  });

  it('should return all skills when fullDepth is true', async () => {
    // Create root SKILL.md
    writeFileSync(
      join(testDir, 'SKILL.md'),
      `---
name: root-skill
description: Root level skill
---

# Root Skill
`
    );

    // Create nested skills in skills/ directory
    mkdirSync(join(testDir, 'skills', 'nested-skill-1'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'nested-skill-1', 'SKILL.md'),
      `---
name: nested-skill-1
description: Nested skill 1
---

# Nested Skill 1
`
    );

    mkdirSync(join(testDir, 'skills', 'nested-skill-2'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'nested-skill-2', 'SKILL.md'),
      `---
name: nested-skill-2
description: Nested skill 2
---

# Nested Skill 2
`
    );

    const skills = await discoverSkills(testDir, undefined, { fullDepth: true });

    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['nested-skill-1', 'nested-skill-2', 'root-skill']);
  });

  it('should default to bounded full repo scan when no option is provided', async () => {
    // Create root SKILL.md
    writeFileSync(
      join(testDir, 'SKILL.md'),
      `---
name: root-skill
description: Root level skill
---

# Root Skill
`
    );

    // Create nested skill
    mkdirSync(join(testDir, 'skills', 'nested-skill'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'nested-skill', 'SKILL.md'),
      `---
name: nested-skill
description: Nested skill
---

# Nested Skill
`
    );

    const skills = await discoverSkills(testDir);

    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(['root-skill', 'nested-skill']);
  });

  it('should still find all skills when no root SKILL.md exists (regardless of fullDepth)', async () => {
    // No root SKILL.md, just nested skills

    mkdirSync(join(testDir, 'skills', 'skill-1'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'skill-1', 'SKILL.md'),
      `---
name: skill-1
description: Skill 1
---

# Skill 1
`
    );

    mkdirSync(join(testDir, 'skills', 'skill-2'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'skill-2', 'SKILL.md'),
      `---
name: skill-2
description: Skill 2
---

# Skill 2
`
    );

    // Without fullDepth
    const skillsDefault = await discoverSkills(testDir);
    expect(skillsDefault).toHaveLength(2);

    // With fullDepth
    const skillsFullDepth = await discoverSkills(testDir, undefined, { fullDepth: true });
    expect(skillsFullDepth).toHaveLength(2);
  });

  it('should report duplicate skill names with separate paths', async () => {
    // Edge case: root SKILL.md and a nested skill with the same name
    writeFileSync(
      join(testDir, 'SKILL.md'),
      `---
name: my-skill
description: Root level skill
---

# Root Skill
`
    );

    // Create nested skill with same name
    mkdirSync(join(testDir, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'my-skill', 'SKILL.md'),
      `---
name: my-skill
description: Nested skill with same name
---

# Nested Skill
`
    );

    const skills = await discoverSkills(testDir, undefined, { fullDepth: true });

    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(['my-skill', 'my-skill']);
    expect(new Set(skills.map((s) => s.path)).size).toBe(2);
  });

  it('should preserve direct subpath single-skill behavior unless fullDepth is set', async () => {
    mkdirSync(join(testDir, 'skills', 'parent', 'children', 'child'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'parent', 'SKILL.md'),
      `---
name: parent
description: Parent skill
---
`
    );
    writeFileSync(
      join(testDir, 'skills', 'parent', 'children', 'child', 'SKILL.md'),
      `---
name: child
description: Child skill
---
`
    );

    const direct = await discoverSkills(testDir, 'skills/parent');
    expect(direct.map((s) => s.name)).toEqual(['parent']);

    const fullDepth = await discoverSkills(testDir, 'skills/parent', { fullDepth: true });
    expect(fullDepth.map((s) => s.name)).toEqual(['parent', 'child']);
  });

  it('should scan nested skills through depth 10', async () => {
    const parts = Array.from({ length: 10 }, (_, index) => `d${index}`);
    const skillDir = join(testDir, ...parts);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: deep-skill
description: Deep skill
---
`
    );

    const skills = await discoverSkills(testDir);
    expect(skills.map((s) => s.name)).toEqual(['deep-skill']);
  });

  it('should fall back to parent folder name when name frontmatter is missing', async () => {
    const skillDir = join(testDir, 'plugins', 'semrush-context', 'skills', 'daily-briefing');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
description: Daily briefing skill
version: 0.1.0
---

# Daily Briefing
`
    );

    const skills = await discoverSkills(testDir);
    expect(skills.map((s) => s.name)).toEqual(['daily-briefing']);
  });
});
