const CSI_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_PM_APC_RE = /\x1b[P^_][\s\S]*?(?:\x1b\\)/g;
const SIMPLE_ESC_RE = /\x1b[\x20-\x7e]/g;
const C1_RE = /[\x80-\x9f]/g;
const CONTROL_RE = /[\x00-\x06\x07\x08\x0b\x0c\x0d-\x1a\x1c-\x1f\x7f]/g;
export function stripTerminalEscapes(str: string): string {
  return str
    .replace(OSC_RE, '') // OSC first (longest match)
    .replace(DCS_PM_APC_RE, '') // DCS/PM/APC
    .replace(CSI_RE, '') // CSI sequences
    .replace(SIMPLE_ESC_RE, '') // Simple ESC+char
    .replace(C1_RE, '') // C1 control codes
    .replace(CONTROL_RE, ''); // Raw control chars (keep \t \n)
}
export function sanitizeMetadata(str: string): string {
  return stripTerminalEscapes(str)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}
