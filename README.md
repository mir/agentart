# agentart

Agentart is the CLI for the open agent MCP and skills ecosystem.

<!-- agent-list:start -->

Supports **Claude Code**, **Codex**, **Cursor**, **Gemini CLI**, **GitHub Copilot**, **OpenCode**, and **Pi**.

<!-- agent-list:end -->

[![skills.sh](https://skills.sh/b/vercel-labs/agentart)](https://skills.sh/vercel-labs/agentart)

## Install the CLI

Download the `agentart` binary for your platform from
[GitHub Releases](https://github.com/vercel-labs/agentart/releases), put it somewhere on your `PATH`, and make it
executable on macOS/Linux:

```bash
chmod +x agentart
agentart --help
```

This project ships as native Bun-compiled executables. Package-runner based execution is intentionally unsupported.

## Install a Skill

```bash
agentart add vercel-labs/agent-skills
```

### Source Formats

```bash
# GitHub shorthand (owner/repo)
agentart add vercel-labs/agent-skills

# Full GitHub URL
agentart add https://github.com/vercel-labs/agent-skills

# Direct path to a skill in a repo
agentart add https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines

# GitLab URL
agentart add https://gitlab.com/org/repo

# Any git URL
agentart add git@github.com:vercel-labs/agent-skills.git

# Local path
agentart add ./my-local-skills
```

### Options

| Option                    | Description                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-g, --global`            | Install to user directory instead of project                                                                                                       |
| `-a, --agent <agents...>` | <!-- agent-names:start -->Target specific agents (e.g., `claude-code`, `codex`). See [Supported Agents](#supported-agents)<!-- agent-names:end --> |
| `-s, --skill <skills...>` | Install specific skills by name (use `'*'` for all skills)                                                                                         |
| `--mcp <servers...>`      | Install discovered MCP servers by name (use `'*'` for all MCP servers)                                                                             |
| `--no-mcp`                | Do not prompt for or install discovered MCP servers                                                                                                |
| `-l, --list`              | List available skills without installing                                                                                                           |
| `--copy`                  | Copy files instead of symlinking to agent directories                                                                                              |
| `-y, --yes`               | Skip all confirmation prompts                                                                                                                      |
| `--all`                   | Install all skills to all agents without prompts                                                                                                   |

### Examples

```bash
# List skills in a repository
agentart add vercel-labs/agent-skills --list

# Install specific skills
agentart add vercel-labs/agent-skills --skill frontend-design --skill skill-creator

# Install a skill with spaces in the name (must be quoted)
agentart add owner/repo --skill "Convex Best Practices"

# Install to specific agents
agentart add vercel-labs/agent-skills -a claude-code -a opencode

# Non-interactive installation (CI/CD friendly)
agentart add vercel-labs/agent-skills --skill frontend-design -g -a claude-code -y

# Install all skills from a repo to all agents
agentart add vercel-labs/agent-skills --all

# Install all skills to specific agents
agentart add vercel-labs/agent-skills --skill '*' -a claude-code

# Install specific skills to all agents
agentart add vercel-labs/agent-skills --agent '*' --skill frontend-design

# Install all discovered MCP servers from a repo
agentart add owner/repo --mcp '*' -a codex -y
```

### Installation Scope

| Scope       | Flag      | Location            | Use Case                                      |
| ----------- | --------- | ------------------- | --------------------------------------------- |
| **Project** | (default) | `./<agent>/skills/` | Committed with your project, shared with team |
| **Global**  | `-g`      | `~/<agent>/skills/` | Available across all projects                 |

### Installation Methods

When installing interactively, you can choose:

| Method                    | Description                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Symlink** (Recommended) | Creates symlinks from each agent to a canonical copy. Single source of truth, easy updates. |
| **Copy**                  | Creates independent copies for each agent. Use when symlinks aren't supported.              |

## Other Commands

| Command                    | Description                                         |
| -------------------------- | --------------------------------------------------- |
| `agentart list`            | List installed skills and MCP servers (alias: `ls`) |
| `agentart remove [skills]` | Remove installed skills from agents                 |
| `agentart update [skills]` | Update installed skills to latest versions          |
| `agentart mcp <command>`   | Manage MCP servers for supported agents             |

### `agentart list`

List all installed skills and MCP servers across project and global scope.

```bash
# List all installed skills and MCP servers
agentart list

# Filter by specific agents
agentart ls -a claude-code -a cursor
```

### `agentart update`

```bash
# Update all skills (interactive scope prompt)
agentart update

# Update a single skill by name
agentart update my-skill

# Update multiple specific skills
agentart update frontend-design web-design-guidelines

# Update only global or project skills
agentart update -g
agentart update -p

# Non-interactive (auto-detects scope: project if in a project, else global)
agentart update -y
```

| Option          | Description                                                               |
| --------------- | ------------------------------------------------------------------------- |
| `-g, --global`  | Only update global skills                                                 |
| `-p, --project` | Only update project skills                                                |
| `-y, --yes`     | Skip scope prompt (auto-detect: project if in a project dir, else global) |
| `[skills...]`   | Update specific skills by name instead of all                             |

### `agentart mcp`

Manage MCP servers in supported agent configuration files.

```bash
# Add a stdio MCP server
agentart mcp add context7 -- npx -y @upstash/context7-mcp

# Add a remote MCP server
agentart mcp add docs --url https://example.com/mcp -a codex cursor -y

# List configured project and global MCP servers
agentart mcp list

# Remove an MCP server
agentart mcp remove context7 -y

# Restore or re-apply MCP servers from lock
agentart mcp install -y
agentart mcp update -y

# Print the MCP lock file
agentart mcp lock
```

### `agentart remove`

Remove installed skills from agents.

```bash
# Remove interactively (select from installed skills)
agentart remove

# Remove specific skill by name
agentart remove web-design-guidelines

# Remove multiple skills
agentart remove frontend-design web-design-guidelines

# Remove from global scope
agentart remove --global web-design-guidelines

# Remove from specific agents only
agentart remove --agent claude-code cursor my-skill

# Remove all installed skills without confirmation
agentart remove --all

# Remove all skills from a specific agent
agentart remove --skill '*' -a cursor

# Remove a specific skill from all agents
agentart remove my-skill --agent '*'

# Use 'rm' alias
agentart rm my-skill
```

| Option         | Description                                      |
| -------------- | ------------------------------------------------ |
| `-g, --global` | Remove from global scope (~/) instead of project |
| `-a, --agent`  | Remove from specific agents (use `'*'` for all)  |
| `-s, --skill`  | Specify skills to remove (use `'*'` for all)     |
| `-y, --yes`    | Skip confirmation prompts                        |
| `--all`        | Shorthand for `--skill '*' --agent '*' -y`       |

## What are Agent Skills?

Agent skills are reusable instruction sets that extend your coding agent's capabilities. They're defined in `SKILL.md`
files with YAML frontmatter containing a `name` and `description`.

Skills let agents perform specialized tasks like:

- Generating release notes from git history
- Creating PRs following your team's conventions
- Integrating with external tools (Linear, Notion, etc.)

Discover skills at **[skills.sh](https://skills.sh)**

## Supported Agents

Skills can be installed to any of these agents:

<!-- supported-agents:start -->

| Agent          | `--agent`        | Project Path      | Global Path                  |
| -------------- | ---------------- | ----------------- | ---------------------------- |
| Claude Code    | `claude-code`    | `.claude/skills/` | `~/.claude/skills/`          |
| Codex          | `codex`          | `.agents/skills/` | `~/.codex/skills/`           |
| Cursor         | `cursor`         | `.agents/skills/` | `~/.cursor/skills/`          |
| Gemini CLI     | `gemini-cli`     | `.agents/skills/` | `~/.gemini/skills/`          |
| GitHub Copilot | `github-copilot` | `.agents/skills/` | `~/.copilot/skills/`         |
| OpenCode       | `opencode`       | `.agents/skills/` | `~/.config/opencode/skills/` |
| Pi             | `pi`             | `.pi/skills/`     | `~/.pi/agent/skills/`        |

<!-- supported-agents:end -->

The CLI automatically detects which coding agents you have installed. If none are detected, you'll be prompted to select
which agents to install to.

## Creating Skills

Skills are directories containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it
---

# My Skill

Instructions for the agent to follow when this skill is activated.

## When to Use

Describe the scenarios where this skill should be used.

## Steps

1. First, do this
2. Then, do that
```

### Required Fields

- `name`: Unique identifier (lowercase, hyphens allowed)
- `description`: Brief explanation of what the skill does

### Optional Fields

- `metadata.internal`: Set to `true` to hide the skill from normal discovery. Internal skills are only visible and
  installable when `INSTALL_INTERNAL_SKILLS=1` is set. Useful for work-in-progress skills or skills meant only for
  internal tooling.

```markdown
---
name: my-internal-skill
description: An internal skill not shown by default
metadata:
  internal: true
---
```

### Skill Discovery

The CLI searches for skills in these locations within a repository:

<!-- skill-discovery:start -->

- Root directory (if it contains `SKILL.md`)
- `skills/`
- `skills/.curated/`
- `skills/.experimental/`
- `skills/.system/`
- `.claude/skills/`
- `.agents/skills/`
- `.pi/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.opencode/skills/`
<!-- skill-discovery:end -->

### Plugin Manifest Discovery

If `.claude-plugin/marketplace.json` or `.claude-plugin/plugin.json` exists, skills declared in those files are also discovered:

```json
// .claude-plugin/marketplace.json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    {
      "name": "my-plugin",
      "source": "my-plugin",
      "skills": ["./skills/review", "./skills/test"]
    }
  ]
}
```

This enables compatibility with the [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) ecosystem.

If no skills are found in standard locations, a recursive search is performed.

## Compatibility

Skills are generally compatible across supported agents since they follow the shared
[Agent Skills specification](https://agentskills.io). Agent-specific extensions can differ; check the relevant agent
documentation for details.

## Troubleshooting

### "No skills found"

Ensure the repository contains valid `SKILL.md` files with both `name` and `description` in the frontmatter.

### Skill not loading in agent

- Verify the skill was installed to the correct path
- Check the agent's documentation for skill loading requirements
- Ensure the `SKILL.md` frontmatter is valid YAML

### Permission errors

Ensure you have write access to the target directory.

## Environment Variables

| Variable                  | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `INSTALL_INTERNAL_SKILLS` | Set to `1` or `true` to show and install skills marked as `internal: true` |

```bash
# Install internal skills
INSTALL_INTERNAL_SKILLS=1 agentart add vercel-labs/agent-skills --list
```

## Development

```bash
# Install dependencies
bun install

# Run from source
bun run dev add vercel-labs/agent-skills --list

# Build the local platform executable
bun run build

# Build release executables for supported Bun targets
bun run build:release

# Test and type-check
bun run test
bun run type-check
```

## Related Links

- [Agent Skills Specification](https://agentskills.io)
- [Skills Directory](https://skills.sh)
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
- [Codex Skills Documentation](https://developers.openai.com/codex/skills)
- [Cursor Skills Documentation](https://cursor.com/docs/context/skills)
- [Gemini CLI Skills Documentation](https://geminicli.com/docs/cli/skills/)
- [GitHub Copilot Agent Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [OpenCode Skills Documentation](https://opencode.ai/docs/skills)
- [Pi Skills Documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)

## License

MIT
