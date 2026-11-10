import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseGithubRepo, detectGithubRepo } from '../src/release/repo.js';
import { App } from '../src/release/app.js';
import { render } from '../src/release/view.js';
import { holdthis } from '../examples/holdthis/profile.js';

describe('parseGithubRepo', () => {
  test('parses HTTPS, SSH, and ssh:// forms with optional .git', () => {
    expect(parseGithubRepo('https://github.com/SihoChoii/releaseThis.git')).toBe('SihoChoii/releaseThis');
    expect(parseGithubRepo('https://x-access-token:secret@github.com/SihoChoii/releaseThis.git')).toBe('SihoChoii/releaseThis');
    expect(parseGithubRepo('https://github.com/SihoChoii/releaseThis')).toBe('SihoChoii/releaseThis');
    expect(parseGithubRepo('https://www.github.com/owner/repo.git')).toBe('owner/repo');
    expect(parseGithubRepo('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseGithubRepo('git@github.com:owner/repo')).toBe('owner/repo');
    expect(parseGithubRepo('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('returns null for non-GitHub or empty remotes', () => {
    expect(parseGithubRepo('')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
    expect(parseGithubRepo('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(parseGithubRepo('git@bitbucket.org:owner/repo.git')).toBeNull();
  });
});

describe('detectGithubRepo', () => {
  let temp;
  beforeEach(async () => { temp = await mkdtemp(join(tmpdir(), 'releasethis-repo-')); });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  test('RELEASETHIS_REPO env wins over origin', () => {
    const result = detectGithubRepo(temp, { RELEASETHIS_REPO: 'Acme/Widget' });
    expect(result).toEqual({ repo: 'Acme/Widget', source: 'env' });
  });

  test('parses RELEASETHIS_REPO when given a full URL', () => {
    const result = detectGithubRepo(temp, { RELEASETHIS_REPO: 'git@github.com:Acme/Widget.git' });
    expect(result).toEqual({ repo: 'Acme/Widget', source: 'env' });
  });

  test('reads owner/repo from git remote origin', () => {
    spawnSync('git', ['init'], { cwd: temp });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/SihoChoii/releaseThis.git'], { cwd: temp });
    expect(detectGithubRepo(temp, {})).toEqual({ repo: 'SihoChoii/releaseThis', source: 'origin' });
  });

  test('missing or non-GitHub remote returns null without throwing', () => {
    expect(detectGithubRepo(temp, {})).toEqual({ repo: null, source: null });
    spawnSync('git', ['init'], { cwd: temp });
    spawnSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/owner/repo.git'], { cwd: temp });
    expect(detectGithubRepo(temp, {})).toEqual({ repo: null, source: null });
  });
});

describe('repo in UI', () => {
  test('publish confirm and header include the detected repo', async () => {
    const a = new App({ root: '/tmp', demo: true, repo: 'SihoChoii/releaseThis', profile: holdthis });
    a.workspace = holdthis.demoWorkspace();
    a.runner.demoPace = 0;
    a.publish();
    await a.modal.callback();
    a.publish();
    expect(a.modal.lines.join(' ')).toContain('SihoChoii/releaseThis');
    const frame = render(a, 96, 24, { color: false }).join('\n');
    expect(frame).toContain('SihoChoii/releaseThis');
  });

  test('unknown repo shows a fallback label', async () => {
    const a = new App({ root: '/tmp', demo: true, repo: null, profile: holdthis });
    a.workspace = holdthis.demoWorkspace();
    a.runner.demoPace = 0;
    a.publish();
    await a.modal.callback();
    a.publish();
    expect(a.modal.lines.join(' ')).toContain('repo unknown');
    expect(render(a, 96, 24, { color: false }).join('\n')).toContain('repo unknown');
  });
});
