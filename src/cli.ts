#!/usr/bin/env node

import { runDiscover } from './discover.ts';
import { runInstall } from './install.ts';
import { runList } from './list.ts';
import { runManage } from './manage.ts';
import { runMcpAdd } from './mcp-add.ts';
import { runMarketplace } from './marketplace.ts';
import { runRemove } from './remove.ts';
import { isRunningInAgent } from './detect-agent.ts';
import { showLogo } from './banner.ts';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = packageJson.version;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function showHelp(): void {
  console.log(`
${BOLD}Usage:${RESET} sloprider [command]

${BOLD}Commands:${RESET}
  manage                   Interactive install, update, remove, and list flow
  discover <git-url>       Scan a git repo and print installable skills, MCPs, hooks, and plugins
  install <git-url>        Install explicitly named skills, MCPs, hooks, or plugins
  marketplace add <source> Add a plugin marketplace source
  marketplace list         List configured plugin marketplace entries
  marketplace remove <name> Remove a managed plugin marketplace entry
  mcp add <url>            Add a remote MCP HTTP endpoint
  list                     Show project/global skills, MCPs, hooks, and plugins
  remove skill <name>      Remove an installed skill
  remove mcp <name>        Remove an installed MCP server
  remove hook <name>       Remove a managed project hook bundle
  remove plugin <name>     Remove a managed plugin

${BOLD}Options:${RESET}
  --help, -h               Show help
  --version, -v            Show version
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  try {
    const inAgent = await isRunningInAgent();

    if (!command) {
      await runManage({ showLogo: !inAgent });
      return;
    }

    if (command === '--help' || command === '-h') {
      showHelp();
      return;
    }

    if (command === '--version' || command === '-v') {
      console.log(VERSION);
      return;
    }

    if (command === 'discover') {
      if (!inAgent) showLogo();
      await runDiscover(args);
      return;
    }
    if (command === 'install') {
      if (!inAgent) showLogo();
      await runInstall(args);
      return;
    }
    if (command === 'mcp') {
      if (!inAgent) showLogo();
      await runMcpAdd(args);
      return;
    }
    if (command === 'marketplace') {
      if (!inAgent) showLogo();
      await runMarketplace(args);
      return;
    }
    if (command === 'list') {
      await runList(args);
      return;
    }
    if (command === 'remove') {
      await runRemove(args);
      return;
    }
    if (command === 'manage') {
      await runManage({ showLogo: !inAgent });
      return;
    }

    console.log(`Unknown command: ${command}`);
    console.log(`Run ${BOLD}sloprider --help${RESET} for usage.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
