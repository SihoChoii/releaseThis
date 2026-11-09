import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { cleanOutput } from './terminal.js';

export { cleanOutput };
export const STALE_AFTER_MS = 15_000;

const STATUS_KEYS = new Set(['phase', 'detail', 'progress', 'completed', 'total']);

function clipColumns(value, width) {
  if (value == null || value === '') return null;
  let used = 0, result = '';
  for (const char of String(value)) {
    const size = Bun.stringWidth(char);
    if (used + size > width) break;
    result += char;
    used += size;
  }
  return result || null;
}

function finiteProgress(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function count(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

// null: not a sentinel. { malformed }: log the line. { patch }: replace the slot.
export function takeStatusLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('::status')) return null;
  const rest = trimmed.slice('::status'.length);
  if (rest && !/^\s/.test(rest)) return null;
  const fields = readStatusFields(rest);
  if (!fields) return { malformed: true };
  const patch = {};
  if ('phase' in fields) patch.phase = fields.phase;
  if ('detail' in fields) patch.detail = fields.detail;
  if ('progress' in fields) {
    if (!/^(?:0|1|0?\.\d+|\d+\.\d+)$/.test(fields.progress)) return { malformed: true };
    const progress = Number(fields.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) return { malformed: true };
    patch.progress = progress;
  }
  for (const key of ['completed', 'total']) {
    if (!(key in fields)) continue;
    if (!/^\d+$/.test(fields[key])) return { malformed: true };
    patch[key] = Number(fields[key]);
  }
  return { patch };
}

function readStatusFields(input) {
  const fields = {};
  let i = 0;
  const skip = () => { while (i < input.length && /\s/.test(input[i])) i++; };
  while (true) {
    skip();
    if (i >= input.length) return Object.keys(fields).length ? fields : null;
    const end = input.indexOf('=', i);
    if (end <= i) return null;
    const key = input.slice(i, end);
    if (!STATUS_KEYS.has(key) || Object.hasOwn(fields, key) || /\s/.test(key)) return null;
    i = end + 1;
    if (input[i] === '"') {
      i++;
      let value = '', closed = false;
      while (i < input.length) {
        if (input[i] === '\\') {
          const next = input[i + 1];
          if (next !== '"' && next !== '\\') return null;
          value += next;
          i += 2;
          continue;
        }
        if (input[i] === '"') { closed = true; i++; break; }
        value += input[i++];
      }
      if (!closed || (i < input.length && !/\s/.test(input[i]))) return null;
      fields[key] = value;
    } else {
      const start = i;
      while (i < input.length && !/\s/.test(input[i])) i++;
      if (start === i) return null;
      fields[key] = input.slice(start, i);
    }
  }
}

export function demoSteps(jobId, { demoTag, repo } = {}) {
  const step = (text, status) => ({ text, status });
  const table = {
    build: [
      step('Compiling HoldThis for arm64…', { phase: 'Compile', progress: 1 / 3, completed: 1, total: 3 }),
      step('[1/3] Compile Swift sources', { phase: 'Compile', progress: 1 / 3, completed: 1, total: 3 }),
      step('[2/3] Link HoldThis', { phase: 'Link', progress: 2 / 3, completed: 2, total: 3 }),
      step('[3/3] Stage resources and app icon', { phase: 'Stage', progress: 1, completed: 3, total: 3 }),
    ],
    sign: [
      step('Signing holdthis-remux', { phase: 'Signing' }),
      step('Signing HoldThis.app with Developer ID', { phase: 'Signing' }),
      step('Verifying hardened runtime', { phase: 'Verifying' }),
    ],
    'notarize-app': [
      step('Submitting app to Apple…', { phase: 'Submitting' }),
      step('Waiting for Apple notarization…', { phase: 'Notarizing', detail: 'Waiting for Apple' }),
      step('Accepted. Stapling ticket.', { phase: 'Stapling' }),
    ],
    zip: [
      step('Creating updater ZIP', { phase: 'Packaging' }),
      step('Verifying archive and app signature', { phase: 'Verifying' }),
    ],
    dmg: [
      step('Composing illustrated installer', { phase: 'Packaging' }),
      step('Signing and notarizing disk image', { phase: 'Signing' }),
    ],
    checksums: [
      step('SHA-256: updater ZIP verified', { phase: 'Verifying' }),
      step('SHA-256: installer DMG verified', { phase: 'Verifying' }),
    ],
    preflight: [
      step(`Tag: ${demoTag || 'v1.0.2+3'}`, { phase: 'Checking' }),
      step(`Repo: ${repo || 'repo unknown'}`, { phase: 'Checking' }),
      step('Files: installer DMG, updater ZIP, two SHA-256 files', { phase: 'Checking' }),
    ],
    publish: [
      step('Simulating GitHub upload', { phase: 'Uploading' }),
      step('Simulating release digest verification', { phase: 'Verifying' }),
    ],
  };
  return table[jobId] || [step('Version updated (simulation)', { phase: 'Version' })];
}

export class Runner {
  constructor({ root, script, onChange = () => {}, demo = false, repo = null, env = process.env }) {
    Object.assign(this, { root, script, onChange, demo, repo, env });
    this.logs = [];
    this.jobs = [];
    this.running = false;
    this.cancelled = false;
    this.child = null;
    this.result = null;
    this.logRevision = 0;
    this.statusSlot = null;
    this.demoPace = 600;
  }

  log(text, kind = 'output') {
    for (const line of cleanOutput(text).split(/\r\n|[\r\n]/)) {
      this.logs.push({ id: ++this.logRevision, text: line.slice(0, 4000), kind, at: Date.now(), runStartedAt: this.startedAt });
    }
    if (this.logs.length > 2500) this.logs.splice(0, this.logs.length - 2500);
    this.onChange('log');
  }

  // Latest visible snapshot. Omitted fields clear. An unchanged snapshot does not notify.
  status(patch) {
    const source = patch ?? {};
    const next = {
      phase: clipColumns(source.phase, 40),
      detail: clipColumns(source.detail, 120),
      progress: finiteProgress(source.progress),
      completed: count(source.completed),
      total: count(source.total),
    };
    const slot = this.statusSlot;
    if (slot && slot.phase === next.phase && slot.detail === next.detail && slot.progress === next.progress && slot.completed === next.completed && slot.total === next.total) return;
    this.statusSlot = { ...next, heartbeatAt: Date.now() };
    this.onChange('status');
  }

  // Child stdout and stderr only. log() keeps a literal ::status line in the transcript.
  ingestChildLine(line) {
    const parsed = takeStatusLine(cleanOutput(line));
    if (parsed?.patch) this.status(parsed.patch);
    else this.log(line);
  }

  async run(jobs, { completed = [] } = {}) {
    if (this.running) throw new Error('A release task is already running.');
    this.jobs = [...completed.map(job => ({ ...job })), ...jobs.map(job => ({ ...job, status: 'pending' }))];
    this.running = true;
    this.cancelled = false;
    this.result = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.log(this.demo ? 'Demo session · release actions are simulated.' : 'Starting release task.', 'notice');
    this.onChange('chrome');
    try {
      for (const job of this.jobs) {
        if (job.status === 'done') continue;
        if (this.cancelled) break;
        job.status = 'running';
        job.startedAt = Date.now();
        this.statusSlot = null;
        this.log(`$ ./script/release.sh ${job.args.join(' ')}`, 'command');
        const code = this.demo ? await this.simulate(job) : await this.execute(job);
        job.endedAt = Date.now();
        job.status = this.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
        this.statusSlot = null;
        this.onChange('chrome');
        if (code !== 0 || this.cancelled) {
          this.result = this.cancelled ? 'cancelled' : 'failed';
          this.log(this.cancelled ? 'Task cancelled. Completed steps remain on disk.' : `${job.label} exited with code ${code}. Fix the error above, then rerun this step.`, 'error');
          break;
        }
        this.log(`${job.label} completed.`, 'success');
      }
      this.result ||= this.cancelled ? 'cancelled' : 'done';
      return this.result;
    } catch (error) {
      const active = this.jobs.find(j => j.status === 'running');
      if (active) active.status = 'failed';
      this.statusSlot = null;
      this.result = 'failed';
      this.log(error.message, 'error');
      return this.result;
    } finally {
      this.running = false;
      this.endedAt = Date.now();
      this.onChange('chrome');
    }
  }

  execute(job) {
    return new Promise(resolve => {
      const child = spawn(this.script, job.args, { cwd: this.root, env: { ...this.env, NO_COLOR: '1', TERM: 'dumb' },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder('utf8');
        let buffer = '';
        const consume = value => {
          buffer += value;
          const lines = buffer.split(/\r\n|[\r\n]/);
          buffer = lines.pop();
          for (const line of lines) if (line) this.ingestChildLine(line);
          if (buffer.length > 8000) { this.log(buffer.slice(0, 4000)); buffer = buffer.slice(-4000); }
        };
        stream.on('data', chunk => consume(decoder.write(chunk)));
        stream.on('end', () => { consume(decoder.end()); if (buffer) this.log(buffer); });
      }
      child.on('error', error => this.log(error.message, 'error'));
      child.on('close', async (code, signal) => {
        await child.cancelPromise;
        if (this.child === child) this.child = null;
        if (signal && !this.cancelled) this.log(`Process stopped by ${signal}.`, 'error');
        resolve(code ?? 1);
      });
    });
  }

  cancel() {
    this.cancelled = true;
    const child = this.child;
    if (child && !child.cancelPromise) {
      const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
      // Keep supervising the group even if the shell exits before its children.
      child.cancelPromise = (async () => {
        kill('SIGTERM');
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(-child.pid, 0); } catch { return; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        kill('SIGKILL');
      })();
    }
    this.onChange('chrome');
  }

  async simulate(job) {
    for (const step of demoSteps(job.id, this)) {
      await new Promise(resolve => setTimeout(resolve, this.demoPace));
      if (this.cancelled) return 1;
      this.log(step.text);
      if (step.status) this.status(step.status);
    }
    return 0;
  }
}
