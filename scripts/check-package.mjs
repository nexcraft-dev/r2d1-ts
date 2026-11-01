import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const directory = await mkdtemp(join(tmpdir(), 'r2d1-package-'));
try {
  const archive = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const packed = archive
    ? {
        files: execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .map((path) => {
            assert.ok(path.startsWith('package/'), 'Unexpected tarball path');
            return { path: path.slice('package/'.length) };
          }),
      }
    : JSON.parse(
        execFileSync(
          'npm',
          [
            '--cache',
            '/tmp/r2d1-npm-cache',
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            directory,
          ],
          { encoding: 'utf8' },
        ),
      )[0];
  const files = packed.files.map((f) => f.path);
  for (const file of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/node/index.js',
    'dist/node/index.d.ts',
    'dist/workers/index.js',
    'dist/workers/index.d.ts',
    'README.md',
    'LICENSE',
  ])
    assert.ok(files.includes(file), file);
  assert.ok(files.every((f) => /^(dist\/|examples\/|package\.json$|README\.md$|LICENSE$)/.test(f)));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ type: 'module', private: true }),
  );
  execFileSync(
    'npm',
    [
      '--cache',
      '/tmp/r2d1-npm-cache',
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      archive ?? join(directory, packed.filename),
    ],
    { cwd: directory, stdio: 'pipe' },
  );
  await writeFile(
    join(directory, 'consumer.mjs'),
    `import { R2D1,defineSchema } from '@nexcraft-dev/r2d1';
import {NodeR2DocumentStore,NodeD1IndexStore} from '@nexcraft-dev/r2d1/node';
import {WorkersR2DocumentStore,WorkersD1IndexStore} from '@nexcraft-dev/r2d1/workers';
if([R2D1,defineSchema,NodeR2DocumentStore,NodeD1IndexStore,WorkersR2DocumentStore,WorkersD1IndexStore].some(v=>typeof v!=='function'))throw new Error('Missing export');`,
  );
  execFileSync(process.execPath, [join(directory, 'consumer.mjs')], { stdio: 'pipe' });
  await writeFile(
    join(directory, 'browser.ts'),
    `import {R2D1} from '@nexcraft-dev/r2d1'; import {WorkersD1IndexStore,WorkersR2DocumentStore} from '@nexcraft-dev/r2d1/workers'; export {R2D1,WorkersD1IndexStore,WorkersR2DocumentStore};`,
  );
  const bundled = await build({
    entryPoints: [join(directory, 'browser.ts')],
    platform: 'browser',
    bundle: true,
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(bundled.metafile.inputs).every(
      (path) =>
        !path.includes('@aws-sdk') && !path.includes('@smithy') && !path.includes('/dist/node/'),
    ),
  );
  await writeFile(
    join(directory, 'consumer.ts'),
    `import {defineSchema,R2D1,jsonCodec} from '@nexcraft-dev/r2d1'; import type {DocumentStore,IndexStore} from '@nexcraft-dev/r2d1';
import {NodeR2DocumentStore,NodeD1IndexStore} from '@nexcraft-dev/r2d1/node';
import type {NodeR2Options,NodeD1Options} from '@nexcraft-dev/r2d1/node';
import {WorkersR2DocumentStore,WorkersD1IndexStore} from '@nexcraft-dev/r2d1/workers';
import type {R2BucketBinding,D1DatabaseBinding} from '@nexcraft-dev/r2d1/workers';
export function adapters(r2:NodeR2Options,d1:NodeD1Options,bucket:R2BucketBinding,database:D1DatabaseBinding){return [new NodeR2DocumentStore(r2),new NodeD1IndexStore(d1),new WorkersR2DocumentStore(bucket),new WorkersD1IndexStore(database)];}
interface User{id:string;country:string} const schema=defineSchema<User>({collection:'users',id:'id',indexes:{country:'string'}});
export async function open(doc:DocumentStore,idx:IndexStore){return new R2D1(doc,idx).collection(schema,jsonCodec<User>(v=>v as User));}`,
  );
  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      join(directory, 'consumer.ts'),
    ],
    { cwd: directory, stdio: 'pipe' },
  );
  const manifest = JSON.parse(
    await readFile(join(directory, 'node_modules/@nexcraft-dev/r2d1/package.json'), 'utf8'),
  );
  assert.equal(manifest.name, '@nexcraft-dev/r2d1');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.types, './dist/index.d.ts');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/nexcraft-dev/r2d1-ts.git',
  });
  assert.deepEqual(manifest.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
  assert.deepEqual(manifest.files, ['dist', 'README.md', 'LICENSE', 'examples']);
  assert.deepEqual(Object.keys(manifest.exports), ['.', './node', './workers']);
  for (const [subpath, stem] of [
    ['.', 'index'],
    ['./node', 'node/index'],
    ['./workers', 'workers/index'],
  ]) {
    assert.deepEqual(manifest.exports[subpath], {
      types: `./dist/${stem}.d.ts`,
      import: `./dist/${stem}.js`,
    });
    for (const target of Object.values(manifest.exports[subpath]))
      assert.ok(files.includes(target.slice(2)), target);
  }
  const rootManifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve('package-lock.json'), 'utf8'));
  assert.equal(manifest.version, rootManifest.version);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  console.log(
    `PASS: ${files.length} packed files, installed ESM exports, TypeScript consumer, browser bundle without Node SDKs (${bundled.outputFiles[0].contents.length} bytes)`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
