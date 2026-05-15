import { describe, it, expect } from 'vitest';
import { parseSource } from './source-parser.js';

describe('source-parser', () => {
  describe('GitLab Custom Domains & Subgroups', () => {
    it('parses custom gitlab domain with deep subgroup paths', () => {
      const result = parseSource('https://git.corp.com/group/subgroup/project/-/tree/main/src');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://git.corp.com/group/subgroup/project.git',
        ref: 'main',
        subpath: 'src',
      });
    });

    it('parses custom gitlab domain repo URLs', () => {
      const result = parseSource('https://gitlab.semrush.net/ai/agent-marketplace');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.semrush.net/ai/agent-marketplace.git',
      });
    });

    it('parses custom gitlab domain repo URLs with ref fragments', () => {
      const result = parseSource('https://gitlab.semrush.net/ai/agent-marketplace#main');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.semrush.net/ai/agent-marketplace.git',
        ref: 'main',
      });
    });

    it('parses scheme-less custom gitlab domain repo URLs', () => {
      const result = parseSource('gitlab.semrush.net/ai/agent-marketplace');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.semrush.net/ai/agent-marketplace.git',
      });
    });

    it('parses scp-like custom gitlab domain repo URLs without user', () => {
      expect(parseSource('gitlab.semrush.net:ai/agent-marketplace.git')).toEqual({
        type: 'gitlab',
        url: 'git@gitlab.semrush.net:ai/agent-marketplace.git',
      });
      expect(parseSource('gitlab.semrush.net:ai/agent-marketplace')).toEqual({
        type: 'gitlab',
        url: 'git@gitlab.semrush.net:ai/agent-marketplace.git',
      });
    });

    it('parses scheme-less custom gitlab domain repo URLs with ref fragments', () => {
      const result = parseSource('gitlab.semrush.net/ai/agent-marketplace#main');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.semrush.net/ai/agent-marketplace.git',
        ref: 'main',
      });
    });

    it('parses scheme-less custom gitlab tree URLs with subpaths', () => {
      const result = parseSource('gitlab.semrush.net/ai/agent-marketplace/-/tree/main/skills/foo');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.semrush.net/ai/agent-marketplace.git',
        ref: 'main',
        subpath: 'skills/foo',
      });
    });

    it('parses GitLab blob URLs as the containing directory', () => {
      const result = parseSource(
        'https://gitlab.semrush.net/ai/agent-marketplace/-/blob/master/plugins/codex/.mcp.json?ref_type=heads'
      );
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.semrush.net/ai/agent-marketplace.git',
        ref: 'master',
        subpath: 'plugins/codex',
      });
    });

    it('parses gitlab tree with branch but no path', () => {
      const result = parseSource('https://gitlab.example.com/org/repo/-/tree/v1.0');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.example.com/org/repo.git',
        ref: 'v1.0',
      });
    });

    it('parses custom gitlab domain with port number', () => {
      const result = parseSource('https://git.corp.com:8443/group/repo/-/tree/main');
      expect(result).toMatchObject({
        type: 'gitlab',
        url: 'https://git.corp.com:8443/group/repo.git',
        ref: 'main',
      });
    });

    it('parses http protocol (non-ssl)', () => {
      const result = parseSource('http://git.local/group/repo/-/tree/dev');
      expect(result).toMatchObject({
        type: 'gitlab',
        url: 'http://git.local/group/repo.git',
      });
    });

    it('parses personal project path (~user)', () => {
      const result = parseSource('https://gitlab.com/~user/project/-/tree/main');
      expect(result).toMatchObject({
        type: 'gitlab',
        url: 'https://gitlab.com/~user/project.git',
      });
    });
  });

  describe('Simplified Git Strategy', () => {
    it('treats custom domains with .git as generic git', () => {
      const result = parseSource('https://git.mycompany.com/my-group/my-repo.git');
      expect(result).toEqual({
        type: 'git',
        url: 'https://git.mycompany.com/my-group/my-repo.git',
      });
    });

    it('rejects unsupported generic URLs', () => {
      expect(() => parseSource('https://google.com/search/result')).toThrow(
        'Unsupported git repository source'
      );
      expect(() => parseSource('https://mintlify.com/docs')).toThrow(
        'Provide a git repository link'
      );
      expect(() => parseSource('mintlify.com/docs')).toThrow('Provide a git repository link');
    });

    it('retains official gitlab.com parsing for convenience', () => {
      const result = parseSource('https://gitlab.com/owner/repo');
      expect(result).toEqual({
        type: 'gitlab',
        url: 'https://gitlab.com/owner/repo.git',
      });
    });
  });

  describe('Existing GitHub Support', () => {
    it('parses github shorthand', () => {
      const result = parseSource('vercel-labs/agent-skills');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/vercel-labs/agent-skills.git',
        subpath: undefined,
      });
    });

    it('parses github full URL', () => {
      const result = parseSource('https://github.com/owner/repo/tree/main/path');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
        subpath: 'path',
      });
    });

    it('parses scheme-less github URLs', () => {
      const result = parseSource('github.com/owner/repo');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/owner/repo.git',
      });
    });

    it('parses scheme-less github tree URLs', () => {
      const result = parseSource('github.com/owner/repo/tree/main/path');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
        subpath: 'path',
      });
    });

    it('parses scheme-less explicit .git URLs', () => {
      const result = parseSource('git.example.com/org/repo.git');
      expect(result).toEqual({
        type: 'git',
        url: 'https://git.example.com/org/repo.git',
      });
    });

    it('does not treat GitHub blob anchors as refs', () => {
      const result = parseSource('https://github.com/owner/repo/blob/main/README.md#L10');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
      });
    });

    it('parses GitHub blob URLs as the containing directory', () => {
      const result = parseSource('https://github.com/owner/repo/blob/main/plugins/codex/.mcp.json');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/owner/repo.git',
        ref: 'main',
        subpath: 'plugins/codex',
      });
    });

    it('parses github shorthand with #branch', () => {
      const result = parseSource('vercel-labs/agent-skills#feature/install');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/vercel-labs/agent-skills.git',
        ref: 'feature/install',
        subpath: undefined,
      });
    });

    it('parses github shorthand with trailing slash', () => {
      const result = parseSource('vercel-labs/agent-skills/');
      expect(result).toEqual({
        type: 'github',
        url: 'https://github.com/vercel-labs/agent-skills.git',
        subpath: undefined,
      });
    });

    it('parses SSH git URL with #branch', () => {
      const result = parseSource('git@github.com:owner/repo.git#feature/install');
      expect(result).toEqual({
        type: 'git',
        url: 'git@github.com:owner/repo.git',
        ref: 'feature/install',
      });
    });
  });
});
