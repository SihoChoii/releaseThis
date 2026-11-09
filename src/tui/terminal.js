import { stripVTControlCharacters } from 'node:util';

// Tool output must never be interpreted as cursor or clipboard commands.
export const cleanOutput = text => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

export const palette = { ink: '#e7e9ed', muted: '#929cad', line: '#475569', amber: '#f5bd72', ice: '#83cbd8', mint: '#99d5ad', red: '#f08d96' };
const rgb = hex => hex.match(/[a-f\d]{2}/gi).map(n => parseInt(n, 16)).join(';');
export function painter(color = true) {
  const paint = (text, tone = 'ink', bold = false) => color ? `\x1b[${bold ? '1;' : ''}38;2;${rgb(palette[tone])}m${text}\x1b[0m` : String(text);
  paint.selected = (text, width) => color ? `\x1b[48;2;43;49;60m\x1b[1;38;2;${rgb(palette.amber)}m${fit(text, width)}\x1b[0m` : fit(text, width);
  return paint;
}
const tokens = text => String(text).match(/\x1b\[[0-9;]*m|[^\x1b]/gu) || [];
export function fit(text, width) {
  width = Math.max(0, width);
  let result = '', used = 0;
  for (const token of tokens(text)) {
    const n = token.startsWith('\x1b') ? 0 : Bun.stringWidth(token);
    if (used + n > width) break;
    result += token; used += n;
  }
  return result + (String(text).includes('\x1b') ? '\x1b[0m' : '') + ' '.repeat(width - used);
}
export const plain = text => cleanOutput(String(text)).replace(/[\r\n\t]/g, ' ');
export function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of plain(text).split(' ')) {
    if (line && Bun.stringWidth(line + ' ' + word) > width) { lines.push(line); line = ''; }
    if (line) line += ' ';
    for (const char of word) {
      if (Bun.stringWidth(line + char) > width) { lines.push(line); line = ''; }
      line += char;
    }
  }
  lines.push(line);
  return lines;
}
export const spinner = frame => ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][frame % 10];
export function bar(done, total, width, c) {
  const fill = Math.max(0, Math.min(width, Math.floor(width * (total ? done / total : 0))));
  return c('━'.repeat(fill), 'mint') + c('─'.repeat(width - fill), 'line');
}
export function box(title, lines, width, c, height = lines.length + 2) {
  const content = lines.slice(0, Math.max(0, height - 2));
  while (content.length < height - 2) content.push('');
  const name = ` ${title} `;
  return [c('╭─', 'line') + fit(c(name, 'muted'), Math.min(Bun.stringWidth(name), width - 4)) + c('─'.repeat(Math.max(0, width - 4 - Bun.stringWidth(name))) + '─╮', 'line'),
    ...content.map(line => c('│', 'line') + fit(line, width - 2) + c('│', 'line')),
    c('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯', 'line')];
}
export const splitLine = (left, right, width) => fit(left, Math.max(0, width - Bun.stringWidth(right))) + right;
