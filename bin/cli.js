#!/usr/bin/env bun
import { App } from '../src/release/app.js';
import { detectGithubRepo } from '../src/release/repo.js';
import { render } from '../src/release/view.js';
import { runCockpit } from '../src/tui/runtime.js';
import { holdthis } from '../src/profiles/holdthis.js';

const args = process.argv.slice(2);
const allowed = new Set(['--demo', '--snapshot', '--no-motion', '--help', '-h']);
if (args.some(arg => !allowed.has(arg))) {
  console.error('Unknown option. Use --help for release cockpit options.');
  process.exit(2);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`releaseThis release cockpit · Bun + JavaScript

Usage: releasethis [--demo] [--no-motion] [--snapshot]

  --demo       Simulate every action without changing files or uploading
  --no-motion  Disable animated indicators
  --snapshot   Print one plain-text frame and exit

Uses the current working directory as the host project and reads
git remote origin (or RELEASETHIS_REPO) for the GitHub owner/repo.

Keys: ↑/↓ navigate, Enter select, Tab views, / commands, ? help, Q quit`);
  process.exit(0);
}
const snapshot = args.includes('--snapshot');
if (!snapshot && (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb')) {
  console.error('Open the release cockpit in an interactive terminal. Use --snapshot for plain-text output.');
  process.exit(1);
}

const root = process.cwd();
const { repo } = detectGithubRepo(root);

await runCockpit({
  snapshot,
  render,
  createApp: ({ onChange, onQuit }) => new App({
    root,
    repo,
    demo: args.includes('--demo'),
    motion: !args.includes('--no-motion') && process.env.RELEASETHIS_REDUCED_MOTION !== '1',
    onChange,
    onQuit,
    profile: holdthis,
  }),
});
