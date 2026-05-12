#!/usr/bin/env node

import { runDiscover } from './discover.ts';
import { runList } from './list.ts';
import { runManage } from './manage.ts';
import { runRemove } from './remove.ts';
import { isRunningInAgent } from './detect-agent.ts';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = packageJson.version;
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[38;5;102m';
const TEXT = '\x1b[38;5;145m';
const GRAYS = [
  '\x1b[38;5;250m',
  '\x1b[38;5;248m',
  '\x1b[38;5;245m',
  '\x1b[38;5;243m',
  '\x1b[38;5;240m',
  '\x1b[38;5;238m',
];

const LOGO_LINES = [
  ' █████╗  ██████╗ ███████╗███╗   ██╗████████╗ █████╗ ██████╗ ████████╗',
  '██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝',
  '███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████║██████╔╝   ██║',
  '██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██╔══██║██╔══██╗   ██║',
  '██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ██║  ██║██║  ██║   ██║',
  '╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝',
];

function showLogo(): void {
  console.log();
  LOGO_LINES.forEach((line, i) => console.log(`${GRAYS[i]}${line}${RESET}`));
}

function showBanner(): void {
  showLogo();
  console.log();
  console.log(`${DIM}Agentart: discover and manage agent skills, MCPs, and hooks${RESET}`);
  console.log();
  console.log(`  ${DIM}$${RESET} ${TEXT}agentart discover ${DIM}<git-url>${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}agentart list${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}agentart remove skill ${DIM}<name>${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}agentart remove mcp ${DIM}<name>${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}agentart remove hook ${DIM}<name>${RESET}`);
  console.log(`  ${DIM}$${RESET} ${TEXT}agentart manage${RESET}`);
  console.log();
}

function showHelp(): void {
  console.log(`
${BOLD}Usage:${RESET} agentart <command>

${BOLD}Commands:${RESET}
  discover <git-url>       Scan a git repo for skills, MCPs, and hooks, then install selected items
  list                     Show project/global skills and MCPs, plus managed project hooks
  remove skill <name>      Remove an installed skill
  remove mcp <name>        Remove an installed MCP server
  remove hook <name>       Remove a managed project hook bundle
  manage                   Interactive install, update, and remove flow

${BOLD}Options:${RESET}
  --help, -h               Show help
  --version, -v            Show version
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const inAgent = await isRunningInAgent();

  if (!command) {
    if (!inAgent) showBanner();
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
      await runManage();
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
