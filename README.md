# sloprider

Sloprider is the CLI for discovering and managing agent skills, MCP servers, project hooks, and plugins.

<!-- agent-list:start -->

Supports **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, **GitHub Copilot**, **OpenCode**, and **Pi**.

<!-- agent-list:end -->

## Install

Download the `sloprider` binary for your platform from
[GitHub Releases](https://github.com/mir/sloprider/releases), put it on your `PATH`, and make it executable on
macOS/Linux:

```bash
chmod +x sloprider
sloprider --help
```

## Commands

```bash
sloprider discover <git-url>
sloprider install <git-url> --scope local|global --agents all|agent[,agent...] --skills name[,name...]
sloprider marketplace add <source> --agents codex,claude-code --scope local|global
sloprider marketplace list
sloprider marketplace remove <name> --agents codex,claude-code
sloprider mcp add <url> --scope local|global --agents all|agent[,agent...]
sloprider list
sloprider remove skill <name>
sloprider remove mcp <name>
sloprider remove hook <name>
sloprider remove plugin <name>
sloprider manage
```

### `sloprider discover <git-url>`

Clones a git repository and scans it for skills, MCP server configs, project hook bundles, and plugins. This command is
read-only: it prints discovered artifact names and an explicit `sloprider install` command you can edit and run.

Supported sources are git repositories in these formats:

```bash
sloprider discover https://github.com/vercel-labs/agent-skills
sloprider discover https://gitlab.com/group/agent-skills
sloprider discover gitlab.example.com/group/agent-skills
sloprider discover git@github.com:vercel-labs/agent-skills.git
sloprider discover vercel-labs/agent-skills
```

Accepted source formats are GitHub URLs, GitLab URLs, Git hosting `tree` and `blob` links, SSH git URLs, scheme-less
GitHub/GitLab host URLs, and GitHub shorthand (`owner/repo`). Local paths, arbitrary web URLs, and direct remote MCP
endpoints are not accepted by `discover`; use `sloprider mcp add` for remote MCP HTTP endpoints.

### `sloprider install <git-url>`

Installs explicitly named artifacts from a git repository without prompting:

```bash
sloprider install https://github.com/vercel-labs/agent-skills.git --scope local --agents codex --skills code-review
sloprider install https://github.com/vercel-labs/agent-skills.git --scope global --agents codex,cursor --mcps context7
sloprider install https://github.com/vercel-labs/agent-skills.git --scope local --agents codex --hooks codex-hooks
sloprider install https://github.com/org/plugins.git --scope local --agents codex,claude-code --plugins plugin-a
```

At least one of `--skills`, `--mcps`, `--hooks`, or `--plugins` is required. Artifact names must match names printed by
`sloprider discover`. Use `--agents all` to install the selected artifacts for all compatible agents. Hook bundles are
project-only in V1, so `--scope global --hooks ...` is rejected. Plugin-capable agents are Codex and Claude Code.

### `sloprider marketplace`

Manages plugin marketplace entries. Codex marketplace files are edited directly; Claude Code plugin state is managed by
delegating to `claude plugin ...`.

```bash
sloprider marketplace add ./plugins/my-plugin --agents codex --scope local
sloprider marketplace add https://github.com/org/plugins.git --agents claude-code --scope global
sloprider marketplace list
sloprider marketplace remove my-plugin --agents codex
```

### `sloprider mcp add <url>`

Adds a direct remote MCP HTTP endpoint without scanning a git repository:

```bash
sloprider mcp add example.com
sloprider mcp add https://api.example.com/mcp --name api --scope local --agents codex
```

When the URL has no scheme, sloprider probes HTTPS and then HTTP. It tests the intended URL before `/mcp` variants, uses
the first reachable endpoint, writes the target agent MCP config, and records the server in the MCP lock file so
`sloprider list` and `sloprider remove mcp <name>` continue to work. Without flags, the scope defaults to local and
agents defaults to all MCP-capable agents.

### `sloprider list`

Shows all project-level and global skills/MCPs/plugins for all agents, plus managed project hook bundles.

```bash
sloprider list
```

### `sloprider remove`

Removes an installed artifact by type and name across project and global scope.

```bash
sloprider remove skill web-design-guidelines
sloprider remove mcp context7
sloprider remove hook codex-hooks
sloprider remove plugin my-plugin
```

### `sloprider manage`

Interactive management for installed skills, MCPs, managed project hooks, and plugins:

- remove selected items
- update selected items
- update all items
- discover and install from a git URL
- add a remote MCP server

## Supported Agents

<!-- supported-agents:start -->

| Agent          | ID               | Project Skill Path | Global Skill Path           |
| -------------- | ---------------- | ------------------ | --------------------------- |
| Claude Code    | `claude-code`    | `.claude/skills/`  | `~/.claude/skills/`         |
| Codex          | `codex`          | `.agents/skills/`  | `~/.codex/skills/`          |
| Cursor         | `cursor`         | `.agents/skills/`  | `~/.cursor/skills/`         |
| Gemini CLI     | `gemini-cli`     | `.agents/skills/`  | `~/.gemini/skills/`         |
| GitHub Copilot | `github-copilot` | `.agents/skills/`  | `~/.copilot/skills/`        |
| OpenCode       | `opencode`       | `.agents/skills/`  | `~/.config/opencode/skills` |
| Pi             | `pi`             | `.pi/skills/`      | `~/.pi/agent/skills/`       |

<!-- supported-agents:end -->

## Skills

Skills are directories containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it
---

# My Skill

Instructions for the agent.
```

The CLI scans common skill locations such as `skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/`,
`.opencode/skills/`, `.github/skills/`, and `.pi/skills/`.

## MCP Discovery

The CLI scans supported MCP config locations recursively up to the default repo scan depth, including `.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `opencode.json`, and
`.claude-plugin/plugin.json`.

## Hooks

Sloprider manages native, project-level hook bundles only. It discovers supported hook config locations recursively up to
the default repo scan depth: `.codex/hooks.json`, `.claude/settings.json` hooks, and `.github/hooks/*.json`. Codex
inline TOML hooks are reported as unsupported in V1; publish `.codex/hooks.json` instead.

Project-level hooks are tracked in `sloprider-hook-lock.json`. Sloprider only updates or removes hooks it installed, and
preserves manual hook configuration.

## Plugins

The CLI scans `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and
`.claude-plugin/marketplace.json`. Codex local marketplace entries are written to
`.agents/plugins/marketplace.json`; Codex global marketplace entries are written to
`~/.agents/plugins/marketplace.json`. Plugins are tracked in `sloprider-plugin-lock.json` locally and
`.plugin-lock.json` in the global sloprider state.

## Development

```bash
bun install
bun run dev --help
bun run type-check
bun run test
bun run build
```

Run formatting before committing:

```bash
bun run format
```

## License

MIT
