# agentart

Agentart is the CLI for discovering and managing agent skills, MCP servers, and project hooks.

<!-- agent-list:start -->

Supports **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, **GitHub Copilot**, **OpenCode**, and **Pi**.

<!-- agent-list:end -->

## Install

Download the `agentart` binary for your platform from
[GitHub Releases](https://github.com/vercel-labs/agentart/releases), put it on your `PATH`, and make it executable on
macOS/Linux:

```bash
chmod +x agentart
agentart --help
```

## Commands

```bash
agentart discover <git-url>
agentart list
agentart remove skill <name>
agentart remove mcp <name>
agentart remove hook <name>
agentart manage
```

### `agentart discover <git-url>`

Clones a git repository, scans it for skills, MCP server configs, and project hook bundles, then prompts for:

1. artifacts to install
2. project or global scope
3. target agents for skills and MCPs

Hook bundles are project-only in V1. They install to their native agent format and require explicit confirmation because
hooks execute commands.

Supported sources are git URLs, including HTTPS and SSH:

```bash
agentart discover https://github.com/vercel-labs/agent-skills.git
agentart discover git@github.com:vercel-labs/agent-skills.git
```

### `agentart list`

Shows all project-level and global skills/MCPs for all agents, plus managed project hook bundles.

```bash
agentart list
```

### `agentart remove`

Removes an installed artifact by type and name across project and global scope.

```bash
agentart remove skill web-design-guidelines
agentart remove mcp context7
agentart remove hook codex-hooks
```

### `agentart manage`

Interactive management for installed skills, MCPs, and managed project hooks:

- remove selected items
- update selected items
- update all items
- discover and install from a git URL

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

The CLI scans common MCP config files, including `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.gemini/settings.json`, `.codex/config.toml`, `opencode.json`, and `.claude-plugin/plugin.json`.

## Hooks

Agentart manages native, project-level hook bundles only. It discovers `.codex/hooks.json`,
`.claude/settings.json` hooks, and `.github/hooks/*.json`. Codex inline TOML hooks are reported as unsupported in V1;
publish `.codex/hooks.json` instead.

Project-level hooks are tracked in `agentart-hook-lock.json`. Agentart only updates or removes hooks it installed, and
preserves manual hook configuration.

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
