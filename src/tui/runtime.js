import { emitKeypressEvents } from 'node:readline';
import { createFrameClock } from './frame.js';

export async function runCockpit({ createApp, render, snapshot = false }) {
  let closed = false, previous = [], interval, app, clock;

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
  function paint(kind) {
    if (closed) return;
    app.deferLogIngest = kind === 'input';
    try {
      const lines = render(app, process.stdout.columns || 110, process.stdout.rows || 34, { color: process.env.NO_COLOR === undefined });
      let output = '';
      lines.forEach((line, i) => { if (line !== previous[i]) output += `\x1b[${i + 1};1H\x1b[2K${line}`; });
      if (output) process.stdout.write(output);
      previous = lines;
    } finally {
      app.deferLogIngest = false;
    }
  }
  app = createApp({ onChange: reason => clock?.mark(reason || 'chrome'), onQuit: () => shutdown() });

  async function stopFromSignal() {
    if (app.runner.running) {
      app.runner.cancel();
      while (app.runner.running) await new Promise(resolve => setTimeout(resolve, 50));
    }
    shutdown(130);
  }

  if (snapshot) {
    await app.refresh();
    console.log(render(app, 110, 34, { color: false }).map(line => line.trimEnd()).join('\n'));
    if (!app.workspace) process.exitCode = 1;
    return;
  }

  clock = createFrameClock({ paint, isRunning: () => app.runner.running || app.refreshing, motion: () => app.motion });
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  emitKeypressEvents(process.stdin);
  process.stdin.resume();
  process.stdin.on('keypress', (text, key) => {
    app.key(text, key);
    clock.input();
  });
  process.stdout.on('resize', () => { previous = []; clock.input(); });
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
  interval = setInterval(() => clock.tick(Date.now()), 90);
  clock.input();
  await app.refresh();
  clock.input();
}
