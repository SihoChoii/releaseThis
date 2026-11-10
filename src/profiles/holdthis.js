import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { factStore, fieldTypes, materialize, project, sameVersion } from '../workflow/model.js';
import { checksumProbe, fileProbe, refreshFacts, verifyChecksum } from '../workflow/refresh.js';

const exec = promisify(execFile);
const explain = {
  present: 'Present on disk. Publishing performs signature and Gatekeeper validation.',
  verified: 'SHA-256 matches the corresponding archive.',
  missing: 'This artifact has not been created.',
  mismatch: 'The checksum does not match the archive. Rebuild the archive and regenerate checksums.',
};

const artifacts = [
  { key: 'artifact.app.built', label: 'Built app', path: 'dist/HoldThis.app', kind: 'dir' },
  { key: 'artifact.app.signed', label: 'Signed app', path: 'dist/release/HoldThis.app', kind: 'dir' },
  { key: 'artifact.update.zip', label: 'Updater ZIP', path: 'dist/HoldThis-AppleSilicon.zip', kind: 'file', gatesPublish: true, demoSize: '7.9 MB' },
  { key: 'artifact.installer.dmg', label: 'Installer DMG', path: 'dist/HoldThis-AppleSilicon.dmg', kind: 'file', gatesPublish: true, demoSize: '12.4 MB' },
  { key: 'artifact.update.zip.sha256', label: 'ZIP checksum', path: 'dist/HoldThis-AppleSilicon.zip.sha256', kind: 'checksum', archive: 'artifact.update.zip', gatesPublish: true },
  { key: 'artifact.installer.dmg.sha256', label: 'DMG checksum', path: 'dist/HoldThis-AppleSilicon.dmg.sha256', kind: 'checksum', archive: 'artifact.installer.dmg', gatesPublish: true },
];

const good = fact => !!fact && ['present', 'verified'].includes(fact.state);
const has = (ctx, key) => good(ctx.facts.get(key));
const step = (text, status) => ({ text, status });
const nextPatch = version => version.replace(/\d+$/, n => String(BigInt(n) + 1n));
const nextBuild = build => String(BigInt(build) + 1n);

function bump(facts, index) {
  const source = facts.get('version.source').value;
  const parts = source.version.split('.').map(BigInt);
  parts[index] += 1n;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0n;
  return { version: parts.join('.'), build: nextBuild(source.build) };
}

function suggested(facts) {
  const source = facts.get('version.source').value;
  const built = facts.get('version.built')?.value;
  const checksums = facts.all().filter(fact => fact.kind === 'checksum');
  const complete = sameVersion(source, built) && checksums.length > 0 && checksums.every(fact => fact.state === 'verified');
  return complete
    ? { version: nextPatch(source.version), build: nextBuild(source.build) }
    : { version: source.version, build: source.build };
}

function applyProduced(facts, id, keys) {
  for (const key of keys) {
    const fact = facts.get(key);
    const desc = artifacts.find(item => item.key === key);
    fact.state = desc.kind === 'checksum' ? 'verified' : 'present';
    fact.provenance = { source: 'task', id };
    if (desc.demoSize) fact.size = desc.demoSize;
  }
}

function stage(id, label, detail, extra = {}) {
  return {
    id, label, detail,
    args(ctx) {
      return [id, ...(ctx.mode.signedOnly && extra.signedFlag ? ['--signed-only'] : [])];
    },
    requires: extra.requires || (() => ''),
    skip: extra.skip,
    demo: extra.demo,
    applyDemo: extra.applyDemo,
    onDone: extra.onDone,
    resume: extra.resume || null,
  };
}

const build = stage('build', 'Build app', 'Compile Swift and stage the app bundle', {
  demo: [
    step('Compiling HoldThis for arm64…', { phase: 'Compile', progress: 1 / 3, completed: 1, total: 3 }),
    step('[1/3] Compile Swift sources', { phase: 'Compile', progress: 1 / 3, completed: 1, total: 3 }),
    step('[2/3] Link HoldThis', { phase: 'Link', progress: 2 / 3, completed: 2, total: 3 }),
    step('[3/3] Stage resources and app icon', { phase: 'Stage', progress: 1, completed: 3, total: 3 }),
  ],
  applyDemo(facts) { applyProduced(facts, 'build', ['artifact.app.built']); },
});

const sign = stage('sign', 'Sign app', 'Developer ID and hardened runtime', {
  requires: ctx => has(ctx, 'artifact.app.built') ? '' : 'Build the app first.',
  demo: [
    step('Signing holdthis-remux', { phase: 'Signing' }),
    step('Signing HoldThis.app with Developer ID', { phase: 'Signing' }),
    step('Verifying hardened runtime', { phase: 'Verifying' }),
  ],
  applyDemo(facts) {
    const source = facts.get('version.source').value;
    const built = facts.get('version.built');
    built.value = { version: source.version, build: source.build };
    built.state = 'present';
    built.provenance = { source: 'task', id: 'sign' };
    const stapled = facts.get('notarization.stapled');
    stapled.value = false;
    stapled.state = 'missing';
    stapled.provenance = { source: 'task', id: 'sign' };
    applyProduced(facts, 'sign', ['artifact.app.signed']);
  },
});

const notarize = stage('notarize-app', 'Notarize app', 'Submit to Apple and staple the ticket', {
  skip: mode => mode.signedOnly ? 'skipped in signed-only mode' : '',
  requires(ctx) {
    if (ctx.mode.signedOnly) return 'Enable notarization with N first.';
    return has(ctx, 'artifact.app.signed') ? '' : 'Sign the app first.';
  },
  demo: [
    step('Submitting app to Apple…', { phase: 'Submitting' }),
    step('Waiting for Apple notarization…', { phase: 'Notarizing', detail: 'Waiting for Apple' }),
    step('Accepted. Stapling ticket.', { phase: 'Stapling' }),
  ],
  applyDemo(facts) {
    const stapled = facts.get('notarization.stapled');
    stapled.value = true;
    stapled.state = 'present';
    stapled.provenance = { source: 'task', id: 'notarize-app' };
  },
});

const archiveRequires = ctx => {
  if (ctx.mode.signedOnly) return has(ctx, 'artifact.app.signed') ? '' : 'Sign the app first.';
  return ctx.facts.get('notarization.stapled')?.value ? '' : 'Notarize and staple the app first.';
};

const zip = stage('zip', 'Updater archive', 'Package and verify the update ZIP', {
  signedFlag: true,
  requires: archiveRequires,
  demo: [
    step('Creating updater ZIP', { phase: 'Packaging' }),
    step('Verifying archive and app signature', { phase: 'Verifying' }),
  ],
  applyDemo(facts) { applyProduced(facts, 'zip', ['artifact.update.zip']); },
});

const dmg = stage('dmg', 'Installer image', 'Create the illustrated installer DMG', {
  signedFlag: true,
  requires: archiveRequires,
  demo: [
    step('Composing illustrated installer', { phase: 'Packaging' }),
    step('Signing and notarizing disk image', { phase: 'Signing' }),
  ],
  applyDemo(facts) { applyProduced(facts, 'dmg', ['artifact.installer.dmg']); },
});

const checksums = stage('checksums', 'Verify checksums', 'Write SHA-256 for both archives', {
  requires(ctx) {
    return has(ctx, 'artifact.update.zip') && has(ctx, 'artifact.installer.dmg') ? '' : 'Create both the ZIP and DMG first.';
  },
  demo: [
    step('SHA-256: updater ZIP verified', { phase: 'Verifying' }),
    step('SHA-256: installer DMG verified', { phase: 'Verifying' }),
  ],
  applyDemo(facts) { applyProduced(facts, 'checksums', ['artifact.update.zip.sha256', 'artifact.installer.dmg.sha256']); },
  onDone(ctx) {
    return ctx.mode.signedOnly
      ? 'Signed archives created. Enable notarization for a public release.'
      : 'Release packaged. Press P to validate and review publishing.';
  },
});

const version = {
  id: 'version',
  label: 'Set version',
  detail: 'Write the release version into the source tree',
  resume: 'reopen-form',
  args(ctx) {
    const source = ctx.facts.get('version.source').value;
    const { version: next, build } = ctx.params;
    return ['version', next, ...(build === source.build ? ['--keep-build'] : ['--build', build])];
  },
  demo: [step('Version updated (simulation)', { phase: 'Version' })],
  applyDemo(facts, ctx) {
    const source = facts.get('version.source');
    const args = ctx.job.args;
    source.value = { version: args[1], build: args.includes('--build') ? args.at(-1) : source.value.build };
    source.provenance = { source: 'task', id: 'version' };
  },
};

const preflight = {
  id: 'preflight',
  label: 'Publish validation',
  detail: 'Check archives, Gatekeeper, and the GitHub tag',
  args: () => ['publish', '--dry-run'],
  demo(runner) {
    return [
      step(`Tag: ${runner.demoTag || 'v1.0.2+3'}`, { phase: 'Checking' }),
      step(`Repo: ${runner.repo || 'repo unknown'}`, { phase: 'Checking' }),
      step('Files: installer DMG, updater ZIP, two SHA-256 files', { phase: 'Checking' }),
    ];
  },
};

const upload = {
  id: 'publish',
  label: 'Publish release',
  detail: 'Upload the archives and mark the release latest',
  args: () => ['publish'],
  demo: [
    step('Simulating GitHub upload', { phase: 'Uploading' }),
    step('Simulating release digest verification', { phase: 'Verifying' }),
  ],
};

const catalog = [build, sign, notarize, zip, dmg, checksums];
const tasks = Object.fromEntries([build, sign, notarize, zip, dmg, checksums, version, preflight, upload].map(task => [task.id, task]));

function artifactFact(desc, extra = {}) {
  return {
    key: desc.key,
    role: 'artifact',
    kind: desc.kind,
    label: desc.label,
    path: desc.path,
    short: desc.path.replace(/^dist\//, ''),
    state: 'missing',
    size: '',
    modifiedAt: null,
    gatesPublish: !!desc.gatesPublish,
    explain,
    provenance: { source: 'probe', id: desc.key },
    ...extra,
  };
}

function versionFacts(source, built, stapled) {
  return [
    { key: 'version.source', role: 'source-version', value: source, state: source ? 'present' : 'missing', provenance: { source: 'probe', id: 'version.source' } },
    { key: 'version.built', role: 'built-version', value: built, state: built ? 'present' : 'missing', provenance: { source: 'probe', id: 'version.built' } },
    {
      key: 'notarization.stapled', role: 'check', value: !!stapled, state: stapled ? 'present' : 'missing',
      whenTrue: '✓ App notarization ticket is stapled', whenFalse: '○ App notarization ticket not verified',
      provenance: { source: 'probe', id: 'notarization.stapled' },
    },
  ];
}

export function demoFacts() {
  return factStore([
    ...versionFacts({ version: '1.0.3', build: '4' }, { version: '1.0.2', build: '3' }, true),
    ...artifacts.map(desc => artifactFact(desc, {
      state: desc.kind === 'checksum' ? 'verified' : 'present',
      size: desc.demoSize || '',
      provenance: { source: 'task', id: 'demo' },
    })),
  ]);
}

export function demoWorkspace() {
  return project(demoFacts());
}

async function plistVersion(path, env) {
  const buddy = env.HOLDTHIS_PLIST_BUDDY || '/usr/libexec/PlistBuddy';
  const values = await Promise.all(['CFBundleShortVersionString', 'CFBundleVersion'].map(async key =>
    (await exec(buddy, ['-c', `Print :${key}`, path], { timeout: 10000 })).stdout.trim()));
  if (!fieldTypes.semver(values[0]) || !fieldTypes.integer(values[1])) throw new Error('Invalid version in Info.plist');
  return { version: values[0], build: values[1] };
}

export async function checksumOK(archive, checksum) {
  try { return await verifyChecksum(archive, checksum); }
  catch { return false; }
}

const byArtifact = Object.fromEntries(artifacts.map(desc => [desc.key, desc]));

const probes = [
  {
    id: 'version.source',
    facts: ['version.source'],
    async run({ root, facts, env }) {
      const source = await plistVersion(env?.HOLDTHIS_INFO_PLIST || join(root, 'Resources/Info.plist'), env || process.env);
      facts.set({
        key: 'version.source', role: 'source-version', value: source, state: 'present',
        provenance: { source: 'probe', id: 'version.source' },
      });
    },
  },
  {
    id: 'version.built',
    facts: ['version.built'],
    async run({ root, facts, env }) {
      const built = await plistVersion(join(root, 'dist/release/HoldThis.app/Contents/Info.plist'), env || process.env).catch(() => null);
      facts.set({
        key: 'version.built', role: 'built-version', value: built, state: built ? 'present' : 'missing',
        provenance: { source: 'probe', id: 'version.built' },
      });
    },
  },
  {
    id: 'notarization.stapled',
    facts: ['notarization.stapled'],
    async run({ root, facts }) {
      const app = join(root, 'dist/release/HoldThis.app');
      const info = await stat(app).catch(() => null);
      const stapled = info?.isDirectory()
        ? await exec('xcrun', ['stapler', 'validate', app], { timeout: 15000 }).then(() => true, () => false)
        : false;
      facts.set({
        key: 'notarization.stapled', role: 'check', value: !!stapled, state: stapled ? 'present' : 'missing',
        whenTrue: '✓ App notarization ticket is stapled', whenFalse: '○ App notarization ticket not verified',
        provenance: { source: 'probe', id: 'notarization.stapled' },
      });
    },
  },
  ...artifacts.map(desc => desc.kind === 'checksum'
    ? checksumProbe(desc, byArtifact[desc.archive], artifactFact)
    : fileProbe(desc, artifactFact)),
];

export async function inspect(root, env = process.env) {
  const { facts } = await refreshFacts({ profile: { probes, demoFacts }, root, demo: false, env });
  return facts;
}

export function commandLine(args) {
  return `./script/release.sh ${args.join(' ')}`;
}

const release = {
  id: 'release',
  kind: 'form',
  title: 'Release pipeline',
  fields: [
    { name: 'version', type: 'semver', label: 'Version' },
    { name: 'build', type: 'integer', label: 'Build' },
  ],
  presets: [
    { name: 'Suggested', opening: true, apply: suggested },
    { name: 'Patch', apply: facts => bump(facts, 2) },
    { name: 'Minor', apply: facts => bump(facts, 1) },
    { name: 'Major', apply: facts => bump(facts, 0) },
    { name: 'Rebuild', apply: facts => ({ ...facts.get('version.source').value }) },
  ],
  help: 'Increase the build to deliver an update. Rebuild keeps the current version and build.',
  submit: 'Review release →',
  hint(ctx) {
    return ctx.mode.signedOnly
      ? 'Signed only: skips Apple notarization.'
      : 'Build, sign, notarize, and package both archives.';
  },
  validate(ctx) {
    const { version: next, build: nextBuildNumber } = ctx.params;
    if (!fieldTypes.semver(next)) return 'Use major.minor.patch, for example 1.0.3.';
    if (!fieldTypes.integer(nextBuildNumber)) return 'The build must be a positive integer.';
    const source = ctx.facts.get('version.source').value;
    if (BigInt(nextBuildNumber) < BigInt(source.build)) return `Build must be ${source.build} or greater.`;
    return '';
  },
  review(ctx, jobs) {
    const source = ctx.facts.get('version.source').value;
    const { version: next, build: nextBuildNumber } = ctx.params;
    const signedOnly = ctx.mode.signedOnly;
    return {
      title: 'Review release',
      lines: [
        `Source  ${source.version} (build ${source.build})`,
        `Target  ${next} (build ${nextBuildNumber})`, '',
        `${jobs.length} stages: ${signedOnly ? 'build, sign, ZIP, DMG, checksums' : 'build, sign, notarize, ZIP, DMG, checksums'}`,
        `Notary profile: ${ctx.env?.NOTARY_PROFILE || 'memomo-notary'}`,
        ...(nextBuildNumber === source.build ? ['Build stays the same. Existing users will not receive an update.'] : []),
        ...(signedOnly ? ['Signed only: this is not a Gatekeeper-ready release.'] : []),
        '', 'Publishing is a separate action after the build.',
      ],
      accept: ctx.demo ? 'Simulate release' : 'Start release',
    };
  },
  resolve(ctx) {
    const source = ctx.facts.get('version.source').value;
    const { version: next, build: nextBuildNumber } = ctx.params;
    const jobs = [];
    if (next !== source.version || nextBuildNumber !== source.build) jobs.push(materialize(version, ctx));
    for (const task of catalog) {
      if (task.skip?.(ctx.mode)) continue;
      jobs.push(materialize(task, ctx));
    }
    return jobs;
  },
};

const publish = {
  id: 'publish',
  kind: 'gated',
  resume: 'revalidate',
  resolve(ctx) {
    return this.steps.map(step => ({ ...materialize(tasks[step.taskId], ctx),
      ...(step.confirm ? { confirm: step.confirm } : {}),
      ...(step.after ? { after: step.after, pauseNotice: step.pauseNotice } : {}),
    }));
  },
  steps: [
    {
      taskId: 'preflight',
      after: 'pause',
      pauseNotice: 'Validation passed. Read the log, then press P to review the upload.',
    },
    {
      taskId: 'publish',
      confirm(ctx) {
        const built = ctx.facts.get('version.built').value;
        const files = ctx.facts.all().filter(fact => fact.gatesPublish).map(fact => fact.short);
        return {
          title: 'Publish to GitHub',
          danger: true,
          lines: [
            `Tag: v${built.version}+${built.build}`,
            `Repo: ${ctx.repo || 'repo unknown'}`, '',
            ...files, '',
            'Creates a public release and marks it latest.',
            'The release script revalidates the files before upload.',
          ],
          accept: ctx.demo ? 'Simulate upload' : 'Publish release',
        };
      },
    },
  ],
  blocked(ctx) {
    if (ctx.mode.signedOnly) return 'Enable notarization with N before publishing.';
    const built = ctx.facts.get('version.built')?.value;
    const needed = ctx.facts.all().filter(fact => fact.gatesPublish);
    if (!built || needed.some(fact => !good(fact))) return 'Build both archives and verify their checksums first.';
    return '';
  },
  confirmStart(ctx) {
    const source = ctx.facts.get('version.source').value;
    const built = ctx.facts.get('version.built').value;
    return {
      title: 'Validate release for publishing',
      lines: [
        `Built app: ${built.version} (build ${built.build})`,
        ...(!sameVersion(source, built) ? ['Built app differs from source. Publishing ships the built app.'] : []),
        '',
        commandLine(['publish', '--dry-run']),
        'Checks archives, Gatekeeper, GitHub tag, and latest build.',
        'Review the output before choosing to upload.',
      ],
      accept: ctx.demo ? 'Simulate validation' : 'Validate release',
    };
  },
};

export const holdthis = {
  id: 'holdthis',
  script: 'script/release.sh',
  commandLine,
  demoFacts,
  demoWorkspace,
  probes,
  inspect,
  demoTag(facts) {
    const built = facts?.get('version.built')?.value;
    return built ? `v${built.version}+${built.build}` : null;
  },
  header: { subtitle: 'Apple Silicon' },
  mode: {
    id: 'signed-only',
    chip: { on: 'signed only', off: 'notarize & staple' },
    sidebar: { on: 'Signed only', off: 'Notarize & staple', hint: 'N to change' },
    resume: { on: 'signed only', off: 'notarized release' },
  },
  copy: {
    refreshing: 'Reading workspace and verifying checksums…',
    checked: 'R refreshes files and checksums',
    demoIdle: 'All release actions are simulated',
    intro: 'Ready for the next release.',
    aligned: 'Build locally. Review the artifacts. Publish when ready.',
    drifted: 'Source has changed. Publishing uses the built app.',
    publishReady: 'P to validate the release for publishing',
    files: 'Files in dist/',
    legend: 'Present = on disk. Verified = SHA-256 matches.',
    artifactHint: 'Enter shows full path, timestamp, and verification details.',
    signed: (versionText, checked) => `Signed app: ${versionText}  •  checked ${checked}`,
    stepsIntro: 'Choose a stage to inspect and run.',
    stepsReady: 'Enter to review this step before running it.',
    stepsBlocked: 'Complete the prerequisite, then refresh with R.',
    tip: 'Tip: press / to find any command.',
  },
  artifacts,
  catalog,
  tasks,
  plans: { release, publish },
  actions: [
    {
      id: 'release', home: true, plan: 'release', bindings: [{ key: '1' }],
      label: 'New release', detail: 'Choose a version, then run the complete pipeline.',
      palette: 'New release', paletteHint: '1', paletteDetail: 'Choose a version and build the full pipeline',
      helpKey: '1', help: 'New release',
    },
    {
      id: 'publish', home: true, plan: 'publish', bindings: [{ key: '2' }, { key: 'p' }],
      label: 'Publish release',
      detailFor: app => app.preflightReady ? 'Validation passed. Review the public upload.' : 'Check existing archives and review the upload.',
      palette: 'Publish release', paletteHint: 'P', paletteDetail: 'Validate artifacts and review the upload',
      helpKey: '2 / P', help: 'Publish release',
    },
    {
      id: 'steps', home: true, screen: 'steps', bindings: [{ key: '3' }],
      label: 'Run one step', detail: 'Run any available stage on its own.',
      palette: 'Run one pipeline step', paletteHint: '3', paletteDetail: 'Run any available stage on its own',
      helpKey: '3', help: 'Run individual steps',
    },
    {
      id: 'mode', toggle: true, bindings: [{ key: 'n' }],
      palette: 'Toggle notarization', paletteHint: 'N', paletteDetail: 'Skip notarization and flag archives as signed only',
      helpKey: 'N', help: 'Toggle notarization',
      hint: 'N mode', hintOrder: { home: 3 },
    },
  ],
};
