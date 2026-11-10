import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'out');
const archive = join(out, 'library.tgz');
const checksum = archive + '.sha256';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const output = (result.stdout || '') + (result.stderr || '');
  if (output) process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}).`);
  return output;
}

async function digest() {
  return createHash('sha256').update(await readFile(archive)).digest('hex');
}

async function validate() {
  const expected = (await readFile(checksum, 'utf8')).trim();
  if (expected !== `${await digest()}  library.tgz`) throw new Error('Package checksum does not match. Run release again.');
  run('tar', ['-tzf', archive]);
}

async function release(task) {
  switch (task) {
    case 'test': {
      console.log('::status phase=Test');
      await mkdir(out, { recursive: true });
      await rm(join(out, 'test.txt'), { force: true });
      const output = run(process.execPath, ['test', './library.test.js']);
      await writeFile(join(out, 'test.txt'), output);
      console.log('tests passed');
      break;
    }
    case 'pack':
      console.log('::status phase=Pack');
      await readFile(join(out, 'test.txt'));
      run('tar', ['-czf', archive, 'package.json', 'library.js']);
      console.log('archive packed');
      break;
    case 'checksum':
      console.log('::status phase=Checksum');
      await writeFile(checksum, `${await digest()}  library.tgz\n`);
      console.log('checksum written');
      break;
    case 'validate':
      console.log('::status phase=Validate');
      await validate();
      console.log('validation passed');
      break;
    case 'upload': {
      console.log('::status phase=Upload');
      await validate();
      const published = join(out, 'published');
      await mkdir(published, { recursive: true });
      await copyFile(archive, join(published, 'library.tgz'));
      await copyFile(checksum, join(published, 'library.tgz.sha256'));
      console.log('package uploaded to out/published');
      break;
    }
    default:
      throw new Error('Usage: ./release.sh test|pack|checksum|validate|upload');
  }
}

try { await release(process.argv[2]); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
