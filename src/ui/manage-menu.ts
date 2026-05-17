import * as readline from 'readline';
import { Writable } from 'stream';
import pc from './colors.ts';
import { countVisualRowsForLines } from './search-multiselect.ts';

export type ManageMenuKind = 'skill' | 'mcp' | 'hook' | 'plugin' | 'marketplace-entry';
export type ManageMenuScope = 'project' | 'global';
export type ManageMenuAction =
  | { type: 'category'; scope: ManageMenuScope; kind: ManageMenuKind }
  | { type: 'artifact'; key: string }
  | { type: 'artifact-action'; action: 'update' | 'remove' }
  | { type: 'install' }
  | { type: 'install-source'; index: number }
  | { type: 'install-add-git-repo' }
  | { type: 'add-mcp' }
  | { type: 'back' }
  | { type: 'quit' };

export type ManageMenuRow = {
  label: string;
  value: ManageMenuAction;
  depth?: number;
  selectable?: boolean;
  count?: number;
  hint?: string;
};

const cancelSymbol = Symbol('cancel');
const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function formatRow(row: ManageMenuRow): string {
  const depth = '  '.repeat(row.depth ?? 0);
  const count = row.count === undefined ? '' : String(row.count).padStart(3);
  const hint = row.hint ? `  ${pc.dim(row.hint)}` : '';
  const label = `${depth}${row.label}${count ? ` ${count}` : ''}${hint}`;
  return row.selectable === false ? pc.dim(label) : label;
}

export async function promptManageMenu(
  rows: ManageMenuRow[],
  options: { title?: string } = {}
): Promise<ManageMenuAction | symbol> {
  return new Promise((resolve) => {
    const selectable = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.selectable !== false);
    if (selectable.length === 0) {
      resolve(cancelSymbol);
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: silentOutput,
      terminal: false,
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin, rl);

    let cursor = 0;
    let lastRenderHeight = 0;

    const clearRender = (): void => {
      if (lastRenderHeight > 0) {
        process.stdout.write(`\x1b[${lastRenderHeight}A`);
        for (let i = 0; i < lastRenderHeight; i++) process.stdout.write('\x1b[2K\x1b[1B');
        process.stdout.write(`\x1b[${lastRenderHeight}A`);
      }
    };

    const close = (value: ManageMenuAction | symbol, _state: 'submit' | 'cancel'): void => {
      clearRender();
      process.stdout.write(`${pc.bold(options.title ?? 'Manage')}\n`);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.off('keypress', onKeypress);
      rl.close();
      resolve(value);
    };

    const render = (): void => {
      clearRender();
      const lines = [pc.bold(options.title ?? 'Manage'), ''];
      const activeIndex = selectable[cursor]!.index;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        const prefix = index === activeIndex ? pc.cyan('>') : ' ';
        lines.push(`${prefix} ${formatRow(row)}`);
      }
      lines.push('');
      lines.push(pc.dim('↑↓ move, enter select, esc quit'));
      process.stdout.write(`${lines.join('\n')}\n`);
      lastRenderHeight = countVisualRowsForLines(lines, process.stdout.columns);
    };

    const onKeypress = (_str: string, key: readline.Key): void => {
      if (key.name === 'up') {
        cursor = (cursor - 1 + selectable.length) % selectable.length;
        render();
      } else if (key.name === 'down') {
        cursor = (cursor + 1) % selectable.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        close(selectable[cursor]!.row.value, 'submit');
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        close(cancelSymbol, 'cancel');
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
}
