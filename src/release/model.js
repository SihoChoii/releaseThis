import { join, basename } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prettyBytes } from '../tui/format.js';

const exec = promisify(execFile);
export const STAGES = [
  { id: 'build', label: 'Build app', detail: 'Compile Swift and stage the app bundle' },
  { id: 'sign', label: 'Sign app', detail: 'Developer ID and hardened runtime' },
  { id: 'notarize-app', label: 'Notarize app', detail: 'Submit to Apple and staple the ticket' },
  { id: 'zip', label: 'Updater archive', detail: 'Package and verify the update ZIP' },
  { id: 'dmg', label: 'Installer image', detail: 'Create the illustrated installer DMG' },
  { id: 'checksums', label: 'Verify checksums', detail: 'Write SHA-256 for both archives' },
];
export const ARTIFACTS = [
  ['Built app', 'dist/HoldThis.app', 'dir'],
  ['Signed app', 'dist/release/HoldThis.app', 'dir'],
  ['Updater ZIP', 'dist/HoldThis-AppleSilicon.zip', 'file'],
  ['Installer DMG', 'dist/HoldThis-AppleSilicon.dmg', 'file'],
  ['ZIP checksum', 'dist/HoldThis-AppleSilicon.zip.sha256', 'checksum', 2],
  ['DMG checksum', 'dist/HoldThis-AppleSilicon.dmg.sha256', 'checksum', 3],
];
export const validVersion = v => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export const validBuild = v => /^[1-9]\d*$/.test(v);
export const sameVersion = (a, b) => !!a && !!b && a.version === b.version && a.build === b.build;
export const nextPatch = v => v.replace(/\d+$/, n => String(BigInt(n) + 1n));
export const nextBuild = b => String(BigInt(b) + 1n);

async function plistVersion(path, env) {
  const buddy = env.HOLDTHIS_PLIST_BUDDY || '/usr/libexec/PlistBuddy';
  const values = await Promise.all(['CFBundleShortVersionString', 'CFBundleVersion'].map(async key =>
    (await exec(buddy, ['-c', `Print :${key}`, path], { timeout: 10000 })).stdout.trim()));
  if (!validVersion(values[0]) || !validBuild(values[1])) throw new Error('Invalid version in Info.plist');
  return { version: values[0], build: values[1] };
}

export async function checksumOK(archive, checksum) {
  try {
    const [expected, recorded] = (await readFile(checksum, 'utf8')).trim().split(/\s+/);
    if (!/^[a-f\d]{64}$/i.test(expected) || recorded !== basename(archive)) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    return hash.digest('hex') === expected.toLowerCase();
  } catch { return false; }
}

export async function inspectWorkspace(root, env = process.env) {
  const source = await plistVersion(env.HOLDTHIS_INFO_PLIST || join(root, 'Resources/Info.plist'), env);
  const built = await plistVersion(join(root, 'dist/release/HoldThis.app/Contents/Info.plist'), env).catch(() => null);
  const artifacts = await Promise.all(ARTIFACTS.map(async ([label, path, kind, archive]) => {
    const full = join(root, path);
    const info = await stat(full).catch(() => null);
    const exists = !!info && (kind === 'dir' ? info.isDirectory() : info.isFile());
    let state = exists ? 'present' : 'missing';
    if (kind === 'checksum' && exists) state = await checksumOK(join(root, ARTIFACTS[archive][1]), full) ? 'verified' : 'mismatch';
    return { label, path, state, size: exists && kind !== 'dir' ? prettyBytes(info.size) : '', modifiedAt: exists ? info.mtimeMs : null };
  }));
  let stapled = false;
  if (built) {
    stapled = await exec('xcrun', ['stapler', 'validate', join(root, 'dist/release/HoldThis.app')], { timeout: 15000 })
      .then(() => true, () => false);
  }
  return { source, built, artifacts, stapled };
}

export function releaseDefaults(workspace) {
  const complete = sameVersion(workspace.source, workspace.built) && workspace.artifacts.slice(4).every(a => a.state === 'verified');
  return { version: complete ? nextPatch(workspace.source.version) : workspace.source.version,
    build: complete ? nextBuild(workspace.source.build) : workspace.source.build };
}

export function planRelease(source, version, build, signedOnly) {
  if (!validVersion(version)) throw new Error('Use major.minor.patch, for example 1.0.3.');
  if (!validBuild(build)) throw new Error('The build must be a positive integer.');
  if (BigInt(build) < BigInt(source.build)) throw new Error(`Build must be ${source.build} or greater.`);
  const jobs = [];
  if (version !== source.version || build !== source.build) {
    jobs.push({ id: 'version', label: 'Set version', args: ['version', version, ...(build === source.build ? ['--keep-build'] : ['--build', build])] });
  }
  for (const stage of STAGES) {
    if (signedOnly && stage.id === 'notarize-app') continue;
    jobs.push({ ...stage, args: [stage.id, ...(signedOnly && ['zip', 'dmg'].includes(stage.id) ? ['--signed-only'] : [])] });
  }
  return jobs;
}

export function stepBlock(id, workspace, signedOnly) {
  const has = i => ['present', 'verified'].includes(workspace.artifacts[i]?.state);
  if (id === 'sign' && !has(0)) return 'Build the app first.';
  if (id === 'notarize-app' && signedOnly) return 'Enable notarization with N first.';
  if (id === 'notarize-app' && !has(1)) return 'Sign the app first.';
  if (['zip', 'dmg'].includes(id) && !(signedOnly ? has(1) : workspace.stapled)) return signedOnly ? 'Sign the app first.' : 'Notarize and staple the app first.';
  if (id === 'checksums' && !(has(2) && has(3))) return 'Create both the ZIP and DMG first.';
  return '';
}

export function publishBlock(workspace, signedOnly) {
  if (signedOnly) return 'Enable notarization with N before publishing.';
  if (!workspace.built || workspace.artifacts.slice(2).some(a => !['present', 'verified'].includes(a.state))) return 'Build both archives and verify their checksums first.';
  return '';
}

export function demoWorkspace() {
  return { source: { version: '1.0.3', build: '4' }, built: { version: '1.0.2', build: '3' }, stapled: true,
    artifacts: ARTIFACTS.map(([label, path, kind], i) => ({ label, path, state: kind === 'checksum' ? 'verified' : 'present', size: i === 2 ? '7.9 MB' : i === 3 ? '12.4 MB' : '' })) };
}
