import assert from 'node:assert/strict';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

// This command only packs an artifact. It never publishes or changes Git state.
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const version = process.env.RELEASE_VERSION;
assert.ok(version, 'Set RELEASE_VERSION to the reviewed package version');
assert.equal(manifest.name, '@nexcraft-dev/r2d1', 'Unexpected package name');
assert.equal(version, manifest.version, 'Release input must match package.json version');
assert.match(version, /^\d+\.\d+\.\d+$/, 'This workflow publishes stable versions only');
const directory = resolve(process.argv[2] ?? 'release');
await mkdir(directory, { recursive: true });
assert.deepEqual(await readdir(directory), [], 'Use an empty release directory');
const [packed] = JSON.parse(
  execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    encoding: 'utf8',
  }),
);
assert.equal(packed.name, manifest.name);
assert.equal(packed.version, version);
assert.equal(packed.filename, `nexcraft-dev-r2d1-${version}.tgz`);
const bytes = await readFile(join(directory, packed.filename));
const digest = createHash('sha256').update(bytes).digest('hex');
await writeFile(join(directory, 'SHA256SUMS'), `${digest}  ${packed.filename}\n`);
console.log(`Prepared ${packed.filename}. No package was published.`);
