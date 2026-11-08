#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { App } from './app.js';
import { render } from './view.js';

const args = process.argv.slice(2);
const allowed = new Set(['--demo', '--snapshot', '--no-motion', '--help', '-h']);
if (args.some(arg => !allowed.has(arg))) {
  console.error('Unknown option. Use --help for release cockpit options.');
  process.exit(2);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`HoldThis release cockpit · Bun + JavaScript\n\nUsage: bun run tui [--demo] [--no-motion] [--snapshot]\n\n  --demo       Simulate every action without changing files or uploading\n  --no-motion  Disable animated indicators\n  --snapshot   Print one plain-text frame and exit\n\nKeys: ↑/↓ navigate, Enter select, Tab views, / commands, ? help, Q quit`);
  process.exit(0);
}
const snapshot = args.includes('--snapshot');
if (!snapshot && (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb')) {
  console.error('Open the release cockpit in an interactive terminal. Use --snapshot for plain-text output.');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let dirty = true, closed = false, previous = [], interval;
const app = new App({ root, demo: args.includes('--demo'), motion: !args.includes('--no-motion') && process.env.HOLDTHIS_REDUCED_MOTION !== '1',
  onChange: () => { dirty = true; }, onQuit: () => shutdown() });

function restore() {
  if (closed) return;
  closed = true;
  clearInterval(interval);
  if (!snapshot) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }
}
function shutdown(code = 0) { restore(); process.exitCode = code; }
async function stopFromSignal() {
  if (app.runner.running) {
    app.runner.cancel();
    while (app.runner.running) await new Promise(resolve => setTimeout(resolve, 50));
  }
  shutdown(130);
}
function draw() {
  if (closed || !dirty && !app.runner.running && !app.refreshing) return;
  dirty = false;
  const lines = render(app, process.stdout.columns || 110, process.stdout.rows || 34, { color: process.env.NO_COLOR === undefined });
  let output = '';
  lines.forEach((line, i) => { if (line !== previous[i]) output += `\x1b[${i + 1};1H\x1b[2K${line}`; });
  if (output) process.stdout.write(output);
  previous = lines;
}

if (snapshot) {
  await app.refresh();
  console.log(render(app, 110, 34, { color: false }).map(line => line.trimEnd()).join('\n'));
  if (!app.workspace) process.exitCode = 1;
} else {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  emitKeypressEvents(process.stdin);
  process.stdin.resume();
  process.stdin.on('keypress', (text, key) => {
    app.key(text, key);
    draw();
  });
  process.stdout.on('resize', () => { previous = []; dirty = true; draw(); });
  process.on('SIGINT', stopFromSignal);
  process.on('SIGTERM', stopFromSignal);
  process.on('exit', restore);
  const fail = async error => {
    app.runner.cancel();
    restore();
    console.error(error);
    while (app.runner.running) await new Promise(resolve => setTimeout(resolve, 50));
    process.exitCode = 1;
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  interval = setInterval(draw, 90);
  draw();
  await app.refresh();
  draw();
}
