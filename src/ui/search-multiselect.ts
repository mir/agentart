import * as readline from 'readline';
import { stripVTControlCharacters } from 'node:util';
import { Writable } from 'stream';
import pc from './colors.ts';
const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
export interface SearchItem<T> {
  value: T;
  label: string;
  hint?: string;
}
export interface LockedSection<T> {
  title: string;
  items: SearchItem<T>[];
}
export interface SearchMultiselectOptions<T> {
  message: string;
  items: SearchItem<T>[];
  maxVisible?: number;
  initialSelected?: T[];
  required?: boolean;
  lockedSection?: LockedSection<T>;
}
export const cancelSymbol = Symbol('cancel');
export function approxStringWidth(plain: string): number {
  let width = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0)!;
    if (code === 0) continue;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x231a && code <= 0x231b) ||
      (code >= 0x2329 && code <= 0x232a) ||
      (code >= 0x23e9 && code <= 0x23ec) ||
      code === 0x23f0 ||
      code === 0x23f3 ||
      (code >= 0x25fd && code <= 0x25fe) ||
      (code >= 0x2614 && code <= 0x2615) ||
      (code >= 0x2648 && code <= 0x2653) ||
      (code >= 0x267f && code <= 0x267f) ||
      (code >= 0x2693 && code <= 0x2693) ||
      (code >= 0x26a1 && code <= 0x26a1) ||
      (code >= 0x26aa && code <= 0x26ab) ||
      (code >= 0x26bd && code <= 0x26be) ||
      (code >= 0x26c4 && code <= 0x26c5) ||
      (code >= 0x26ce && code <= 0x26ce) ||
      (code >= 0x26d4 && code <= 0x26d4) ||
      (code >= 0x26ea && code <= 0x26ea) ||
      (code >= 0x26f2 && code <= 0x26f3) ||
      (code >= 0x26f5 && code <= 0x26f5) ||
      (code >= 0x26fa && code <= 0x26fa) ||
      (code >= 0x26fd && code <= 0x26fd) ||
      (code >= 0x2705 && code <= 0x2705) ||
      (code >= 0x270a && code <= 0x270b) ||
      (code >= 0x2728 && code <= 0x2728) ||
      (code >= 0x274c && code <= 0x274c) ||
      (code >= 0x274e && code <= 0x274e) ||
      (code >= 0x2753 && code <= 0x2755) ||
      (code >= 0x2757 && code <= 0x2757) ||
      (code >= 0x2795 && code <= 0x2797) ||
      (code >= 0x27b0 && code <= 0x27b0) ||
      (code >= 0x27bf && code <= 0x27bf) ||
      (code >= 0x2b1b && code <= 0x2b1c) ||
      (code >= 0x2b50 && code <= 0x2b50) ||
      (code >= 0x2b55 && code <= 0x2b55) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xa960 && code <= 0xa97c) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f000 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}
export function visualRowsForLine(line: string, columns: number): number {
  const plain = stripVTControlCharacters(line);
  const cols = Math.max(1, columns);
  const w = approxStringWidth(plain);
  return Math.max(1, Math.ceil(w / cols));
}
export function countVisualRowsForLines(lines: string[], columns: number | undefined): number {
  const cols =
    columns !== undefined && columns > 0
      ? columns
      : process.stdout.columns && process.stdout.columns > 0
        ? process.stdout.columns
        : 80;
  return lines.reduce((sum, line) => sum + visualRowsForLine(line, cols), 0);
}
export async function searchMultiselect<T>(
  options: SearchMultiselectOptions<T>
): Promise<T[] | symbol> {
  const {
    message,
    items,
    maxVisible = 8,
    initialSelected = [],
    required = false,
    lockedSection,
  } = options;
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: silentOutput,
      terminal: false,
    });
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(process.stdin, rl);
    let query = '';
    let cursor = 0;
    const selected = new Set<T>(initialSelected);
    let lastRenderHeight = 0;
    const lockedValues = lockedSection ? lockedSection.items.map((i) => i.value) : [];
    const filter = (item: SearchItem<T>, q: string): boolean => {
      if (!q) return true;
      const lowerQ = q.toLowerCase();
      return (
        item.label.toLowerCase().includes(lowerQ) ||
        String(item.value).toLowerCase().includes(lowerQ)
      );
    };
    const getFiltered = (): SearchItem<T>[] => {
      return items.filter((item) => filter(item, query));
    };
    const clearRender = (): void => {
      if (lastRenderHeight > 0) {
        process.stdout.write(`\x1b[${lastRenderHeight}A`);
        for (let i = 0; i < lastRenderHeight; i++) {
          process.stdout.write('\x1b[2K\x1b[1B');
        }
        process.stdout.write(`\x1b[${lastRenderHeight}A`);
      }
    };
    const render = (state: 'active' | 'submit' | 'cancel' = 'active'): void => {
      clearRender();
      const lines: string[] = [];
      const filtered = getFiltered();
      lines.push(pc.bold(message));
      if (state === 'active') {
        if (lockedSection && lockedSection.items.length > 0) {
          lines.push('');
          const lockedTitle = `${pc.bold(lockedSection.title)} ${pc.dim('(always included)')}`;
          lines.push(lockedTitle);
          for (const item of lockedSection.items) {
            lines.push(`  ${pc.green('[x]')} ${pc.bold(item.label)}`);
          }
          lines.push('');
          lines.push(pc.bold('Additional agents'));
        }
        const searchLine = `${pc.dim('Search:')} ${query}${pc.inverse(' ')}`;
        lines.push(searchLine);
        lines.push(pc.dim('↑↓ move, space select, enter confirm'));
        lines.push('');
        const visibleStart = Math.max(
          0,
          Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible)
        );
        const visibleEnd = Math.min(filtered.length, visibleStart + maxVisible);
        const visibleItems = filtered.slice(visibleStart, visibleEnd);
        if (filtered.length === 0) {
          lines.push(pc.dim('No matches found'));
        } else {
          for (let i = 0; i < visibleItems.length; i++) {
            const item = visibleItems[i]!;
            const actualIndex = visibleStart + i;
            const isSelected = selected.has(item.value);
            const isCursor = actualIndex === cursor;
            const marker = isSelected ? pc.green('[x]') : pc.dim('[ ]');
            const label = isCursor ? pc.underline(item.label) : item.label;
            const hint = item.hint ? pc.dim(` (${item.hint})`) : '';
            const prefix = isCursor ? pc.cyan('>') : ' ';
            lines.push(`${prefix} ${marker} ${label}${hint}`);
          }
          const hiddenBefore = visibleStart;
          const hiddenAfter = filtered.length - visibleEnd;
          if (hiddenBefore > 0 || hiddenAfter > 0) {
            const parts: string[] = [];
            if (hiddenBefore > 0) parts.push(`↑ ${hiddenBefore} more`);
            if (hiddenAfter > 0) parts.push(`↓ ${hiddenAfter} more`);
            lines.push(pc.dim(parts.join('  ')));
          }
        }
      } else if (state === 'cancel') {
        lines.push(pc.dim('Cancelled'));
      }
      process.stdout.write(lines.join('\n') + '\n');
      lastRenderHeight = countVisualRowsForLines(lines, process.stdout.columns);
    };
    const cleanup = (): void => {
      process.stdin.removeListener('keypress', keypressHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      rl.close();
    };
    const submit = (): void => {
      if (required && selected.size === 0 && lockedValues.length === 0) {
        return;
      }
      render('submit');
      cleanup();
      resolve([...lockedValues, ...Array.from(selected)]);
    };
    const cancel = (): void => {
      render('cancel');
      cleanup();
      resolve(cancelSymbol);
    };
    const keypressHandler = (_str: string, key: readline.Key): void => {
      if (!key) return;
      const filtered = getFiltered();
      if (key.name === 'return') {
        submit();
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cancel();
        return;
      }
      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key.name === 'down') {
        cursor = Math.min(filtered.length - 1, cursor + 1);
        render();
        return;
      }
      if (key.name === 'space') {
        const item = filtered[cursor];
        if (item) {
          if (selected.has(item.value)) {
            selected.delete(item.value);
          } else {
            selected.add(item.value);
          }
        }
        render();
        return;
      }
      if (key.name === 'backspace') {
        query = query.slice(0, -1);
        cursor = 0;
        render();
        return;
      }
      if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
        query += key.sequence;
        cursor = 0;
        render();
        return;
      }
    };
    process.stdin.on('keypress', keypressHandler);
    render();
  });
}
