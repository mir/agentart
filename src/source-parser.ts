import { isAbsolute, resolve } from 'path';
import type { ParsedSource } from './types.ts';

/**
 * Extract owner/repo (or group/subgroup/repo for GitLab) from a parsed source
 * for lockfile tracking.
 * Returns null for local paths or unparseable sources.
 * Supports any Git host with an owner/repo URL structure, including GitLab subgroups.
 */
export function getOwnerRepo(parsed: ParsedSource): string | null {
  if (parsed.type === 'local') {
    return null;
  }

  // Handle Git SSH URLs (e.g., git@gitlab.com:owner/repo.git, git@github.com:owner/repo.git)
  const sshMatch = parsed.url.match(/^git@[^:]+:(.+)$/);
  if (sshMatch) {
    let path = sshMatch[1]!;
    path = path.replace(/\.git$/, '');

    // Must have at least owner/repo (one slash)
    if (path.includes('/')) {
      return path;
    }
    return null;
  }

  // Handle HTTP(S) URLs
  if (!parsed.url.startsWith('http://') && !parsed.url.startsWith('https://')) {
    return null;
  }

  try {
    const url = new URL(parsed.url);
    // Get pathname, remove leading slash and trailing .git
    let path = url.pathname.slice(1);
    path = path.replace(/\.git$/, '');

    // Must have at least owner/repo (one slash)
    if (path.includes('/')) {
      return path;
    }
  } catch {
    // Invalid URL
  }

  return null;
}

/**
 * Extract owner and repo from an owner/repo string.
 * Returns null if the format is invalid.
 */
export function parseOwnerRepo(ownerRepo: string): { owner: string; repo: string } | null {
  const match = ownerRepo.match(/^([^/]+)\/([^/]+)$/);
  if (match) {
    return { owner: match[1]!, repo: match[2]! };
  }
  return null;
}

/**
 * Check if a GitHub repository is private.
 * Returns true if private, false if public, null if unable to determine.
 * Only works for GitHub repositories (GitLab not supported).
 */
export async function isRepoPrivate(owner: string, repo: string): Promise<boolean | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`);

    // If repo doesn't exist or we don't have access, assume private to be safe
    if (!res.ok) {
      return null; // Unable to determine
    }

    const data = (await res.json()) as { private?: boolean };
    return data.private === true;
  } catch {
    // On error, return null to indicate we couldn't determine
    return null;
  }
}

/**
 * Sanitizes a subpath to prevent path traversal attacks.
 * Rejects subpaths containing ".." segments that could escape the repository root.
 * Returns the sanitized subpath, or throws if the subpath is unsafe.
 */
export function sanitizeSubpath(subpath: string): string {
  // Normalize to forward slashes for consistent handling
  const normalized = subpath.replace(/\\/g, '/');

  // Check each segment for ".."
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(
        `Unsafe subpath: "${subpath}" contains path traversal segments. ` +
          `Subpaths must not contain ".." components.`
      );
    }
  }

  return subpath;
}

/**
 * Check if a string represents a local file system path
 */
function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input) ||
    input.startsWith('./') ||
    input.startsWith('../') ||
    input === '.' ||
    input === '..' ||
    // Windows absolute paths like C:\ or D:\
    /^[a-zA-Z]:[/\\]/.test(input)
  );
}

function isGitLabHostname(hostname: string): boolean {
  return hostname.toLowerCase().includes('gitlab');
}

/**
 * Parse a source string into a structured format
 * Supports: local paths, GitHub URLs, GitLab URLs, GitHub shorthand, SSH git URLs,
 * scheme-less git host URLs, and explicit .git URLs.
 */
// Source aliases: map common shorthand to canonical source
const SOURCE_ALIASES: Record<string, string> = {
  'coinbase/agentWallet': 'coinbase/agentic-wallet-skills',
};

const SUPPORTED_SOURCE_FORMATS = [
  'https://github.com/owner/repo',
  'https://github.com/owner/repo/tree/main/path',
  'https://github.com/owner/repo/blob/main/path/file',
  'https://gitlab.example.com/group/repo',
  'https://gitlab.example.com/group/repo/-/tree/main/path',
  'https://gitlab.example.com/group/repo/-/blob/main/path/file',
  'git@github.com:owner/repo.git',
  'gitlab.example.com:group/repo.git',
  'gitlab.example.com/group/repo',
  'owner/repo',
];

function sourceFormatHelp(input: string): string {
  return [
    `Unsupported git repository source: ${input}`,
    'Provide a git repository link in one of these formats:',
    ...SUPPORTED_SOURCE_FORMATS.map((format) => `  - ${format}`),
  ].join('\n');
}

interface FragmentRefResult {
  inputWithoutFragment: string;
  ref?: string;
  skillFilter?: string;
}

function decodeFragmentValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeGitSource(input: string): boolean {
  if (input.startsWith('github:') || input.startsWith('gitlab:') || input.startsWith('git@')) {
    return true;
  }

  if (isScpLikeHostPathSource(input)) {
    return true;
  }

  const schemeLessHostUrl = normalizeSchemeLessHostUrl(input);
  if (schemeLessHostUrl) {
    return looksLikeGitSource(schemeLessHostUrl);
  }

  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      const parsed = new URL(input);
      const pathname = parsed.pathname;

      // Only treat GitHub fragments as refs for repo/tree URLs.
      if (parsed.hostname === 'github.com') {
        return /^\/[^/]+\/[^/]+(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(pathname);
      }

      // Only treat GitLab fragments as refs for repo/tree URLs.
      if (isGitLabHostname(parsed.hostname)) {
        return /^\/.+?\/[^/]+(?:\.git)?(?:\/-\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(pathname);
      }
    } catch {
      // Fall through to generic checks below.
    }
  }

  if (/^https?:\/\/.+\.git(?:$|[/?])/i.test(input)) {
    return true;
  }

  return (
    !input.includes(':') &&
    !input.startsWith('.') &&
    !input.startsWith('/') &&
    /^([^/]+)\/([^/]+)(?:\/(.+)|@(.+))?$/.test(input)
  );
}

function isScpLikeHostPathSource(input: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return false;
  const match = input.match(/^([^/\s:]+\.[^/\s:]+):(.+)$/);
  return Boolean(match?.[1] && match[2]?.includes('/'));
}

function parseUrl(input: string): URL | null {
  if (!input.startsWith('http://') && !input.startsWith('https://')) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function rawPathParts(input: string): string[] {
  const rawPath = input.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/, 1)[0] ?? '';
  return rawPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
}

function isHostnameSegment(segment: string): boolean {
  return /^(?:localhost|[^/\s:]+\.[^/\s:]+)(?::\d+)?$/i.test(segment);
}

function normalizeSchemeLessHostUrl(input: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return null;
  const firstSlash = input.indexOf('/');
  if (firstSlash <= 0) return null;

  const firstSegment = input.slice(0, firstSlash);
  if (!isHostnameSegment(firstSegment)) return null;

  return `https://${input}`;
}

function parseSshGitSource(input: string): ParsedSource | null {
  const sshMatch = input.match(/^git@([^:]+):(.+)$/);
  if (!sshMatch) return null;

  const [, hostname, rawPath] = sshMatch;
  if (!hostname || !rawPath || !rawPath.includes('/')) return null;

  const cleanPath = rawPath.replace(/\.git$/, '');
  const type = isGitLabHostname(hostname) ? 'gitlab' : 'git';

  return {
    type,
    url: `git@${hostname}:${cleanPath}.git`,
  };
}

function parseScpLikeHostPathSource(input: string): ParsedSource | null {
  const match = input.match(/^([^/\s:]+\.[^/\s:]+):(.+)$/);
  if (!match) return null;

  const [, hostname, rawPath] = match;
  if (!hostname || !rawPath || !rawPath.includes('/')) return null;

  const cleanPath = rawPath.replace(/\.git$/, '');
  return {
    type: isGitLabHostname(hostname) ? 'gitlab' : 'git',
    url: `git@${hostname}:${cleanPath}.git`,
  };
}

function parseGitHubHttpSource(
  input: string,
  fragmentRef?: string,
  fragmentSkillFilter?: string
): ParsedSource | null {
  const parsed = parseUrl(input);
  if (!parsed || parsed.hostname !== 'github.com') return null;

  const parts = rawPathParts(input);
  if (parts.length < 2) return null;

  const [owner, rawRepo] = parts;
  const repo = rawRepo!.replace(/\.git$/, '');
  const base: ParsedSource = {
    type: 'github',
    url: `https://github.com/${owner}/${repo}.git`,
    ...(fragmentRef ? { ref: fragmentRef } : {}),
    ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
  };

  if (parts[2] === 'tree' && parts[3]) {
    const subpath = parts.slice(4).join('/');
    return {
      type: 'github',
      url: base.url,
      ref: parts[3],
      ...(subpath ? { subpath: sanitizeSubpath(subpath) } : {}),
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  if (parts[2] === 'blob' && parts[3]) {
    const filePath = parts.slice(4).join('/');
    const subpath = containingDirectory(filePath);
    return {
      type: 'github',
      url: base.url,
      ref: parts[3],
      ...(subpath ? { subpath: sanitizeSubpath(subpath) } : {}),
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  return base;
}

function gitLabRepoUrl(parsed: URL, repoPath: string): string {
  return `${parsed.protocol}//${parsed.host}/${repoPath.replace(/\.git$/, '')}.git`;
}

function containingDirectory(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 1) return undefined;
  return parts.slice(0, -1).join('/');
}

function parseGitLabRefPathSource(input: string, fragmentRef?: string): ParsedSource | null {
  const parsed = parseUrl(input);
  if (!parsed || parsed.hostname === 'github.com') return null;

  const parts = rawPathParts(input);
  const markerIndex = parts.findIndex(
    (part, index) => part === '-' && ['tree', 'blob'].includes(parts[index + 1] ?? '')
  );
  if (markerIndex < 2) return null;

  const mode = parts[markerIndex + 1];
  const ref = parts[markerIndex + 2];
  if (!mode || !ref) return null;

  const repoPath = parts.slice(0, markerIndex).join('/');
  const refPath = parts.slice(markerIndex + 3).join('/');
  const subpath = mode === 'blob' ? containingDirectory(refPath) : refPath;
  return {
    type: 'gitlab',
    url: gitLabRepoUrl(parsed, repoPath),
    ref: ref || fragmentRef,
    ...(subpath ? { subpath: sanitizeSubpath(subpath) } : {}),
  };
}

function parseGitLabHttpRepo(input: string, ref?: string): ParsedSource | null {
  const parsed = parseUrl(input);
  if (!parsed || !isGitLabHostname(parsed.hostname)) return null;

  const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!repoPath.includes('/') || repoPath.includes('/-/')) return null;

  return {
    type: 'gitlab',
    url: gitLabRepoUrl(parsed, repoPath),
    ...(ref ? { ref } : {}),
  };
}

function parseExplicitGitUrl(input: string, ref?: string): ParsedSource | null {
  const parsed = parseUrl(input);
  if (!parsed || !parsed.pathname.endsWith('.git')) return null;

  return {
    type: 'git',
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    ...(ref ? { ref } : {}),
  };
}

function unsupportedSource(input: string): never {
  throw new Error(sourceFormatHelp(input));
}

function parseGitHubShorthand(
  input: string,
  fragmentRef?: string,
  fragmentSkillFilter?: string
): ParsedSource | null {
  if (input.includes(':') || input.startsWith('.') || input.startsWith('/')) return null;
  const firstSegment = input.split('/')[0] ?? '';
  if (isHostnameSegment(firstSegment)) return null;

  const atSkillMatch = input.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atSkillMatch) {
    const [, owner, repo, skillFilter] = atSkillMatch;
    return {
      type: 'github',
      url: `https://github.com/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      skillFilter: fragmentSkillFilter || skillFilter,
    };
  }

  const shorthandMatch = input.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);
  if (!shorthandMatch) return null;

  const [, owner, repo, subpath] = shorthandMatch;
  return {
    type: 'github',
    url: `https://github.com/${owner}/${repo}.git`,
    ...(fragmentRef ? { ref: fragmentRef } : {}),
    subpath: subpath ? sanitizeSubpath(subpath) : subpath,
    ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
  };
}

function parseFragmentRef(input: string): FragmentRefResult {
  const hashIndex = input.indexOf('#');
  if (hashIndex < 0) {
    return { inputWithoutFragment: input };
  }

  const inputWithoutFragment = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);

  // Treat URL fragments as git refs only for git-like sources.
  if (!fragment || !looksLikeGitSource(inputWithoutFragment)) {
    return { inputWithoutFragment: input };
  }

  const atIndex = fragment.indexOf('@');
  if (atIndex === -1) {
    return {
      inputWithoutFragment,
      ref: decodeFragmentValue(fragment),
    };
  }

  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);
  return {
    inputWithoutFragment,
    ref: ref ? decodeFragmentValue(ref) : undefined,
    skillFilter: skillFilter ? decodeFragmentValue(skillFilter) : undefined,
  };
}

function appendFragmentRef(input: string, ref?: string, skillFilter?: string): string {
  if (!ref) {
    return input;
  }
  return `${input}#${ref}${skillFilter ? `@${skillFilter}` : ''}`;
}

export function parseSource(input: string): ParsedSource {
  // Local path: absolute, relative, or current directory
  if (isLocalPath(input)) {
    const resolvedPath = resolve(input);
    // Return local type even if path doesn't exist - we'll handle validation in main flow
    return {
      type: 'local',
      url: resolvedPath, // Store resolved path in url for consistency
      localPath: resolvedPath,
    };
  }

  const {
    inputWithoutFragment,
    ref: fragmentRef,
    skillFilter: fragmentSkillFilter,
  } = parseFragmentRef(input);
  input = inputWithoutFragment;

  // Resolve source aliases before parsing
  const alias = SOURCE_ALIASES[input];
  if (alias) {
    input = alias;
  }

  const sshSource = parseSshGitSource(input);
  if (sshSource) {
    return {
      ...sshSource,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  const scpLikeSource = parseScpLikeHostPathSource(input);
  if (scpLikeSource) {
    return {
      ...scpLikeSource,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  // Prefix shorthand: github:owner/repo -> owner/repo (handled by existing shorthand logic)
  // Also supports github:owner/repo/subpath and github:owner/repo@skill
  const githubPrefixMatch = input.match(/^github:(.+)$/);
  if (githubPrefixMatch) {
    return parseSource(appendFragmentRef(githubPrefixMatch[1]!, fragmentRef, fragmentSkillFilter));
  }

  // Prefix shorthand: gitlab:owner/repo -> https://gitlab.com/owner/repo
  const gitlabPrefixMatch = input.match(/^gitlab:(.+)$/);
  if (gitlabPrefixMatch) {
    return parseSource(
      appendFragmentRef(
        `https://gitlab.com/${gitlabPrefixMatch[1]!}`,
        fragmentRef,
        fragmentSkillFilter
      )
    );
  }

  const githubSource = parseGitHubHttpSource(input, fragmentRef, fragmentSkillFilter);
  if (githubSource) return githubSource;

  const gitlabRefPathSource = parseGitLabRefPathSource(input, fragmentRef);
  if (gitlabRefPathSource) return gitlabRefPathSource;

  // GitLab URL: https://gitlab.example.com/owner/repo or
  // https://gitlab.com/group/subgroup/repo
  // Supports nested subgroups (e.g., gitlab.com/group/subgroup1/subgroup2/repo).
  const gitlabHttpRepo = parseGitLabHttpRepo(input, fragmentRef);
  if (gitlabHttpRepo) return gitlabHttpRepo;

  const schemeLessHostUrl = normalizeSchemeLessHostUrl(input);
  if (schemeLessHostUrl) {
    return parseSource(appendFragmentRef(schemeLessHostUrl, fragmentRef, fragmentSkillFilter));
  }

  const githubShorthand = parseGitHubShorthand(input, fragmentRef, fragmentSkillFilter);
  if (githubShorthand) return githubShorthand;

  const explicitGitUrl = parseExplicitGitUrl(input, fragmentRef);
  if (explicitGitUrl) return explicitGitUrl;

  return unsupportedSource(input);
}
