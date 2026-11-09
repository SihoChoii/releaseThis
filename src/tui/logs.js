import { wrap } from './terminal.js';
import { duration } from './format.js';

// Append newly arrived lines to the wrap cache. A paused viewport keeps its anchor
// when the buffer grows or the 2,500-line cap drops older rows. An input paint sets
// deferLogIngest so a keypress does not wrap that backlog; the frame tick ingests it.
// Wrapping is budgeted so a burst of long lines yields back to input between batches.
const WRAP_BUDGET = 8000;
const matches = (item, filter) => !filter || item.text.toLowerCase().includes(filter.toLowerCase());

function scheduleCatchUp(app) {
  if (app.logCatchUp) return;
  app.logCatchUp = setTimeout(() => {
    app.logCatchUp = null;
    app.onChange?.('log');
  }, 0);
}

function appendWrapped(rows, item, width, budget) {
  const lines = wrap(item.text, width - 10);
  if (lines.length > budget.left) return false;
  lines.forEach((text, i) => rows.push({ ...item, text, rowId: `${item.id}:${i}`, continuation: i > 0 }));
  budget.left -= lines.length;
  return true;
}

function rebuildLogs(app, width, budget) {
  const rows = [];
  let lastId = 0;
  for (const item of app.runner.logs) {
    if (matches(item, app.logFilter) && !appendWrapped(rows, item, width, budget)) break;
    lastId = item.id;
  }
  return { rows, width, filter: app.logFilter, lastId };
}

function ingestLogs(app, width, budget) {
  const cache = app.logCache, logs = app.runner.logs, firstId = logs[0]?.id ?? Infinity;
  let dropped = 0;
  while (dropped < cache.rows.length && cache.rows[dropped].id < firstId) dropped++;
  if (dropped) cache.rows.splice(0, dropped);
  let start = logs.length;
  while (start > 0 && logs[start - 1].id > cache.lastId) start--;
  let appended = false;
  for (let i = start; i < logs.length; i++) {
    const item = logs[i];
    if (matches(item, cache.filter) && !appendWrapped(cache.rows, item, width, budget)) break;
    cache.lastId = item.id;
    if (matches(item, cache.filter)) appended = true;
  }
  if ((dropped || appended) && app.scroll > 0 && app.logAnchor) {
    const index = cache.rows.findIndex(row => row.rowId === app.logAnchor);
    if (index >= 0) app.scroll = Math.max(0, cache.rows.length - index - 1);
  }
}

function cacheBehind(app, width) {
  const cache = app.logCache;
  const lastId = app.runner.logs.at(-1)?.id ?? 0;
  return !cache || cache.width !== width || cache.filter !== app.logFilter || cache.lastId < lastId;
}

export function visibleLogs(app, width, count) {
  const cache = app.logCache;
  const lastId = app.runner.logs.at(-1)?.id ?? 0;
  if (app.deferLogIngest) {
    if (cacheBehind(app, width)) app.onChange?.('log');
  } else if (!cache || cache.width !== width || cache.filter !== app.logFilter) {
    app.logCache = rebuildLogs(app, width, { left: WRAP_BUDGET });
    if (lastId > app.logCache.lastId) scheduleCatchUp(app);
  } else if (lastId > cache.lastId) {
    ingestLogs(app, width, { left: WRAP_BUDGET });
    if (lastId > app.logCache.lastId) scheduleCatchUp(app);
  }
  const rows = app.logCache?.rows ?? [];
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
