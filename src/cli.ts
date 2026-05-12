#!/usr/bin/env node

import { runDiscover } from './discover.ts';
import { runList } from './list.ts';
import { runManage } from './manage.ts';
import { runRemove } from './remove.ts';
import { isRunningInAgent } from './detect-agent.ts';
import { showLogo } from './banner.ts';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = packageJson.version;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function showHelp(): void {
  console.log(`
${BOLD}Usage:${RESET} agentart [command]

${BOLD}Commands:${RESET}
  manage                   Interactive install, update, remove, and list flow
  discover <git-url>       Scan a git repo for skills, MCPs, and hooks, then install selected items
  list                     Show project/global skills and MCPs, plus managed project hooks
  remove skill <name>      Remove an installed skill
  remove mcp <name>        Remove an installed MCP server
  remove hook <name>       Remove a managed project hook bundle

${BOLD}Options:${RESET}
  --help, -h               Show help
  --version, -v            Show version
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
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

  try {
    if (command === 'discover') {
      if (!inAgent) showLogo();
      await runDiscover(args);
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
    console.log(`Run ${BOLD}agentart --help${RESET} for usage.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
