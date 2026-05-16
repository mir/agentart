export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item));
  }
  return trimmed;
}
function getIndent(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}
function parseBlockScalar(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  marker: string
): { value: string; nextIndex: number } {
  const style = marker[0];
  const chomp = marker[1] ?? '';
  let blockIndent: number | null = null;
  const collected: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const indent = getIndent(line);
    if (trimmed) {
      if (indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = indent;
      if (indent < blockIndent) break;
      collected.push(line.slice(blockIndent));
    } else {
      collected.push('');
    }
    index++;
  }
  let value: string;
  if (style === '>') {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of collected) {
      if (line === '') {
        if (current.length > 0) {
          paragraphs.push(current.join(' '));
          current = [];
        }
        paragraphs.push('');
      } else {
        current.push(line.trim());
      }
    }
    if (current.length > 0) paragraphs.push(current.join(' '));
    value = paragraphs.join('\n');
  } else {
    value = collected.join('\n');
  }
  if (chomp === '-') {
    value = value.replace(/\n+$/, '');
  } else if (chomp !== '+') {
    value = value.replace(/\n*$/, '\n');
  }
  return { value, nextIndex: index };
}
function parseSimpleYaml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let currentObject: Record<string, unknown> | null = null;
  let currentArray: unknown[] | null = null;
  let currentKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = getIndent(line);
    const trimmed = line.trim();
    if (indent > 0 && currentKey) {
      if (trimmed.startsWith('- ')) {
        if (!currentArray) {
          currentArray = [];
          root[currentKey] = currentArray;
        }
        currentArray.push(parseScalar(trimmed.slice(2)));
        continue;
      }
      const nestedMatch = trimmed.match(/^([^:]+):(?:\s*(.*))?$/);
      if (nestedMatch) {
        if (!currentObject) {
          currentObject = {};
          root[currentKey] = currentObject;
        }
        currentObject[nestedMatch[1]!.trim()] = parseScalar(nestedMatch[2] ?? '');
      }
      continue;
    }
    currentObject = null;
    currentArray = null;
    currentKey = null;
    const match = trimmed.match(/^([^:]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2] ?? '';
    if (value === '') {
      currentKey = key;
      root[key] = {};
    } else if (/^[>|][+-]?$/.test(value.trim())) {
      const block = parseBlockScalar(lines, i + 1, indent, value.trim());
      root[key] = block.value;
      i = block.nextIndex - 1;
    } else {
      root[key] = parseScalar(value);
    }
  }
  return root;
}
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };
  const data = parseSimpleYaml(match[1]!);
  return { data, content: match[2] ?? '' };
}
