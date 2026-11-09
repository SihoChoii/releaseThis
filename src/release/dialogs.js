import { box, fit, wrap, plain } from '../tui/terminal.js';

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
    if (!matches.length) body.push(' ' + c('No commands match. Try “logs” or “refresh”.', 'muted'));
    const selected = matches[m.index];
    body.push('', ' ' + c(selected?.detail || 'Type to filter commands by name.', 'muted'));
    footer = [' ' + c(`${matches.length ? m.index + 1 : 0}/${matches.length}   ↑ ↓ select   Enter run   Esc close`, 'muted')];
  } else if (m.type === 'release') {
    title = 'New release';
    const plan = app.activeFormPlan(m);
    const field = (label, value, index) => {
      const selected = m.field === index;
      const available = width - 19;
      const offset = selected ? Math.max(0, m.cursor - available + 1) : 0;
      const shown = selected ? value.slice(offset, m.cursor) + '▏' + value.slice(m.cursor) : value;
      const row = ` ${selected ? '❯' : ' '} ${label.padEnd(10)} ${shown}`;
      return selected ? c.selected(fit(row, width - 3), width - 2) : c(row);
    };
    body = [' ' + c(`F2 preset: ${plan.presets[m.preset]?.name || 'Custom'}`, 'ice'), '',
      ...plan.fields.map((descriptor, index) => field(descriptor.label, String(m[descriptor.name] ?? ''), index)), '',
      ...wrap(plan.hint(app.context()), width - 4).map(l => ' ' + c(l, app.signedOnly ? 'amber' : 'muted')),
      ...wrap(m.error || plan.help, width - 4).map(l => ' ' + c(l, m.error ? 'red' : 'muted'))];
    footer = [m.field === plan.fields.length ? c.selected(` ❯ ${plan.submit}`, width - 2) : c(`   ${plan.submit}`, 'ink', true),
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
    body = (m.type === 'help' ? app.helpLines() : m.lines).flatMap(line => wrap(line, width - 4).map(l => ' ' + c(l)));
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
