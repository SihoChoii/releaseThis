import { wrap } from './terminal.js';
import { duration } from './model.js';

// Cache wrapping across animation frames. Stable row IDs keep a paused viewport
// in place as new output arrives, including when the bounded log buffer rolls over.
export function visibleLogs(app, width, count) {
  const key = `${app.runner.logRevision}:${width}:${app.logFilter}`;
  if (app.logCache?.key !== key) {
    const rows = [];
    for (const item of app.runner.logs) {
      if (app.logFilter && !item.text.toLowerCase().includes(app.logFilter.toLowerCase())) continue;
      wrap(item.text, width - 10).forEach((text, i) => rows.push({ ...item, text, rowId: `${item.id}:${i}`, continuation: i > 0 }));
    }
    if (app.logCache?.width === width && app.logCache?.filter === app.logFilter && app.scroll > 0 && app.logAnchor) {
      const index = rows.findIndex(r => r.rowId === app.logAnchor);
      if (index >= 0) app.scroll = Math.max(0, rows.length - index - 1);
    }
    app.logCache = { key, rows, width, filter: app.logFilter };
  }
  const rows = app.logCache.rows;
  app.scroll = Math.min(app.scroll, Math.max(0, rows.length - count));
  const end = rows.length - app.scroll;
  app.logAnchor = rows[end - 1]?.rowId;
  return { rows: rows.slice(Math.max(0, end - count), end), total: rows.length };
}
export function logLines(app, width, count, c) {
  const { rows, total } = visibleLogs(app, width, count);
  if (!rows.length) return [
    '', ' ' + c(app.logFilter ? `No matches for “${app.logFilter}”.` : 'No output yet.', 'ink', true),
    ' ' + c(app.logFilter ? 'F edit filter    Esc clear filter' : 'Run a release or select an individual step.', 'muted'),
  ];
  app.logRowCount = total;
  return rows.map(item => {
    const tone = { error: 'red', command: 'ice', success: 'mint', notice: 'amber' }[item.kind] || 'ink';
    const stamp = item.continuation ? '      ' : duration(item.at - (item.runStartedAt || item.at)).padStart(6);
    return ' ' + c(stamp, 'muted') + c(' │ ', 'line') + c(item.text, tone);
  });
}
