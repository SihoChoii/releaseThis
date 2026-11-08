import { box, fit, wrap, plain } from './terminal.js';

const help = [
  'Navigate', '↑ ↓ or J K   Move through actions, artifacts, or steps',
  'Enter         Review action / inspect artifact', 'Tab / Shift+Tab   Next / previous view',
  'W / A / L     Workspace / artifacts / logs', '/ or Ctrl+P   Search all commands', '',
  'Release', '1 / 2 / 3     New release / publish / individual steps',
  'F2            Cycle version presets in the editor', 'N             Toggle notarization',
  'T             Review remaining stages after interruption', 'R             Refresh files and checksums', '',
  'Logs', 'F             Filter output (Esc clears the filter)', 'E             Save retained output to dist/tui-logs/',
  'PgUp / PgDn   Scroll a page', 'Home / End    Oldest output / follow live output', '',
  'Session', 'M             Toggle animations', 'Ctrl+C        Stop active task / quit when idle',
  'Esc           Back / close dialog', 'Q             Quit (reviews cancellation while running)',
];

export function dialog(app, width, maxHeight, c) {
  const m = app.modal;
  let title, body = [], footer = [];
  if (m.type === 'palette') {
    title = 'Command palette';
    const matches = app.filteredCommands();
    const count = Math.min(8, maxHeight - 9);
    const start = Math.max(0, Math.min(m.index - count + 1, matches.length - count));
    body = [' ' + c('› ', 'amber') + fit(m.query.slice(-(width - 8)) + '▏', width - 6), ''];
    matches.slice(start, start + count).forEach((cmd, n) => {
      const index = start + n;
      const label = ` ${index === m.index ? '❯' : ' '} ${cmd.label}`;
      const row = fit(label, width - 9) + fit(cmd.hint || '', 5);
      body.push(index === m.index ? c.selected(row, width - 2) : c(row));
    });
    if (!matches.length) body.push(' ' + c('No commands match. Try “build” or “logs”.', 'muted'));
    const selected = matches[m.index];
    body.push('', ' ' + c(selected?.detail || 'Type to filter commands by name.', 'muted'));
    footer = [' ' + c(`${matches.length ? m.index + 1 : 0}/${matches.length}   ↑ ↓ select   Enter run   Esc close`, 'muted')];
  } else if (m.type === 'release') {
    title = 'New release';
    const field = (label, value, index) => {
      const selected = m.field === index;
      const available = width - 19;
      const offset = selected ? Math.max(0, m.cursor - available + 1) : 0;
      const shown = selected ? value.slice(offset, m.cursor) + '▏' + value.slice(m.cursor) : value;
      const row = ` ${selected ? '❯' : ' '} ${label.padEnd(10)} ${shown}`;
      return selected ? c.selected(fit(row, width - 3), width - 2) : c(row);
    };
    body = [' ' + c(`F2 preset: ${['Suggested', 'Patch', 'Minor', 'Major', 'Rebuild'][m.preset ?? 0] || 'Custom'}`, 'ice'), '',
      field('Version', m.version, 0), field('Build', m.build, 1), '',
      ...wrap(app.signedOnly ? 'Signed only: skips Apple notarization.' : 'Build, sign, notarize, and package both archives.', width - 4).map(l => ' ' + c(l, app.signedOnly ? 'amber' : 'muted')),
      ...wrap(m.error || 'Increase the build to deliver an update. Rebuild keeps the current version and build.', width - 4).map(l => ' ' + c(l, m.error ? 'red' : 'muted'))];
    footer = [m.field === 2 ? c.selected(' ❯ Review release →', width - 2) : c('   Review release →', 'ink', true),
      ' ' + c('Tab next   Ctrl+U clear   Enter next   Esc close', 'muted')];
  } else if (m.type === 'filter') {
    title = 'Filter log output';
    const matches = app.runner.logs.filter(l => l.text.toLowerCase().includes(m.query.toLowerCase())).length;
    body = ['', ' ' + c('› ', 'amber') + fit(m.query.slice(-(width - 8)) + '▏', width - 6), '',
      ' ' + c(`${matches} matching log entries`, 'ice'),
      ...wrap('Matches text across the retained session log. An empty filter shows everything.', width - 4).map(l => ' ' + c(l, 'muted')), ''];
    footer = [' ' + c('Enter apply   Ctrl+U clear   Esc cancel', 'muted')];
  } else {
    title = m.type === 'help' ? 'Keyboard controls' : m.title;
    body = (m.type === 'help' ? help : m.lines).flatMap(line => wrap(line, width - 4).map(l => ' ' + c(l)));
    if (m.type === 'confirm') {
      const cancel = m.choice === 0 ? c('❯ Cancel', 'amber', true) : c('  Cancel', 'muted');
      const action = c(`${m.choice === 1 ? '❯' : ' '} ${m.action}`, m.choice === 1 ? m.danger ? 'red' : 'amber' : 'ink', true);
      footer = [' ' + cancel + '    ' + action, ' ' + c(m.back ? 'Tab select   Enter confirm   Esc edit' : 'Tab select   Enter confirm   Esc cancel', 'muted')];
    } else footer = [' ' + c('Enter / Esc close', 'muted')];
  }
  // Reserve controls before allocating a scrollable body, even at 58 × 20.
  const room = maxHeight - footer.length - 4;
  const maximum = Math.max(0, body.length - room);
  m.scroll = Math.min(maximum, m.scroll || 0);
  const visible = body.slice(m.scroll, m.scroll + room);
  if (maximum) footer.unshift(' ' + c(`↑ ↓ scroll  ${m.scroll + 1}–${Math.min(m.scroll + room, body.length)} / ${body.length}`, 'ice'));
  else footer.unshift('');
  return box(plain(title), [...visible, ...footer], width, c);
}
