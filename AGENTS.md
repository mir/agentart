# AGENTS.md

This file provides guidance to AI coding agents working on the `sloprider` CLI codebase.

## Project Overview

`sloprider` is the CLI for discovering and managing agent skills, MCP servers, project hooks, and plugins.

## Commands

| Command                               | Description                                           |
| ------------------------------------- | ----------------------------------------------------- |
| `sloprider`                           | Show banner with available commands                   |
| `sloprider discover <git-url>`        | Scan a git repo for skills, MCPs, hooks, plugins      |
| `sloprider install <git-url>`         | Install explicitly named skills, MCPs, hooks, plugins |
| `sloprider marketplace add <source>`  | Add a plugin marketplace source                       |
| `sloprider marketplace list`          | List plugin marketplace entries                       |
| `sloprider marketplace remove <name>` | Remove a plugin marketplace entry                     |
| `sloprider list`                      | List project/global skills/MCPs/hooks/plugins         |
| `sloprider remove skill <name>`       | Remove an installed skill                             |
| `sloprider remove mcp <name>`         | Remove an installed MCP server                        |
| `sloprider remove hook <name>`        | Remove a managed project hook bundle                  |
| `sloprider remove plugin <name>`      | Remove a managed plugin                               |
| `sloprider manage`                    | Interactive install, update, and remove flow          |

There are no command aliases. Direct `discover` is read-only; use `install` with explicit artifact lists for
non-interactive installation.

## Architecture

```
src/
├── cli.ts              # Main command routing and help
├── discover.ts         # Git clone, skill/MCP/hook scan, interactive install flow
├── install.ts          # Non-interactive install command parsing and selection
├── manage.ts           # Interactive management flow
├── list.ts             # Project/global artifact listing
├── remove.ts           # Skill, MCP, and hook removal
├── installer.ts        # Skill filesystem install helpers
├── hooks.ts            # Project hook discovery/install/list/remove
├── hook-lock.ts        # Project hook lock file
├── plugin-discovery.ts # Plugin manifest and marketplace discovery
├── plugin-marketplace.ts # Codex marketplace JSON management
├── plugin-agents.ts    # Plugin-capable agent adapters
├── plugin-registry.ts      # Project/global plugin registry files
├── mcp-config.ts       # Agent MCP config read/write helpers
├── mcp-discovery.ts    # MCP config discovery in repos
├── mcp-lock.ts         # Project/global MCP lock files
├── skills.ts           # Skill discovery and parsing
├── skill-lock.ts       # Global skill lock file
├── local-lock.ts       # Project skill lock file
├── source-parser.ts    # Git URL parsing
├── git.ts              # Git clone operations
├── agents.ts           # Agent definitions and detection
└── types.ts            # Shared TypeScript types
```

## Lock Files

Project-level skills are tracked in `sloprider-lock.json`.
Project-level MCPs are tracked in `sloprider-mcp-lock.json`.
Project-level hooks are tracked in `sloprider-hook-lock.json`.
Project-level plugins are tracked in `sloprider-plugins.json`.
Global skills are tracked in `~/.agents/.skill-lock.json` or `$XDG_STATE_HOME/sloprider/.skill-lock.json`.
Global MCPs are tracked in `~/.agents/.mcp-lock.json` or `$XDG_STATE_HOME/sloprider/.mcp-lock.json`.
Global plugins are tracked in `~/.agents/.plugins.json` or `$XDG_STATE_HOME/sloprider/.plugins.json`.

Hooks are project-only in V1 and sloprider only manages hooks it installed.
Codex plugin marketplace files are managed directly. Claude Code plugin state is managed through `claude plugin ...`.

## Development

```bash
# Install dependencies
bun install

# Run from source
bun run dev --help
bun run dev list

# Build
bun run build

# Run all tests
bun run test

# Type check
bun run type-check

# Format code
bun run format

# Check formatting
bun run format:check
```

## Code Style

This project uses Prettier for code formatting. Always run `bun run format` before committing changes.

## Adding a New Agent

1. Add the agent definition to `src/agents.ts`.
2. Add MCP config support to `src/mcp-agents.ts` if the agent supports MCP servers.
3. Run `bun run validate:agents`.
4. Run `bun run sync:agents` if generated docs or metadata need to change.
