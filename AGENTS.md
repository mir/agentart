# AGENTS.md

This file provides guidance to AI coding agents working on the `agentart` CLI codebase.

## Project Overview

`agentart` is the CLI for discovering and managing agent skills and MCP servers.

## Commands

| Command                        | Description                                       |
| ------------------------------ | ------------------------------------------------- |
| `agentart`                     | Show banner with available commands               |
| `agentart discover <git-url>`  | Scan a git repo for skills and MCPs, then install |
| `agentart list`                | List project and global skills/MCPs               |
| `agentart remove skill <name>` | Remove an installed skill                         |
| `agentart remove mcp <name>`   | Remove an installed MCP server                    |
| `agentart manage`              | Interactive install, update, and remove flow      |

There are no command aliases and no non-interactive install flags.

## Architecture

```
src/
├── cli.ts              # Main command routing and help
├── discover.ts         # Git clone, skill/MCP scan, interactive install
├── manage.ts           # Interactive management flow
├── list.ts             # Project/global artifact listing
├── remove.ts           # Skill and MCP removal
├── installer.ts        # Skill filesystem install helpers
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

Project-level skills are tracked in `agentart-lock.json`.
Project-level MCPs are tracked in `agentart-mcp-lock.json`.
Global skills are tracked in `~/.agents/.skill-lock.json` or `$XDG_STATE_HOME/agentart/.skill-lock.json`.
Global MCPs are tracked in `~/.agents/.mcp-lock.json` or `$XDG_STATE_HOME/agentart/.mcp-lock.json`.

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
