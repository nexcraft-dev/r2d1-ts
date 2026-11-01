import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectRelease, stable, compare } from './release-policy.mjs';

const packageName = '@nexcraft-dev/r2d1';
const registry = 'https://registry.npmjs.org/@nexcraft-dev%2fr2d1';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const planPath = () => join(process.env.RUNNER_TEMP, 'r2d1-release-plan.json');
const sha = (value) => {
  assert.match(value, /^[0-9a-f]{40}$/, 'Invalid commit SHA');
  return value;
};

function requireWorkflow() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Release operations run only in GitHub Actions');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(
    process.env.GITHUB_REF,
    'refs/heads/main',
    'Keep the workflow execution context on main',
  );
  assert.equal(process.env.GITHUB_REPOSITORY, 'nexcraft-dev/r2d1-ts');
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/, 'Missing workflow run ID');
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/, 'Missing workflow run attempt');
}

async function output(values) {
  assert.ok(process.env.GITHUB_OUTPUT, 'Missing job output file');
  for (const [name, value] of Object.entries(values)) {
    assert.ok(!String(value).includes('\n'), 'Invalid multiline output');
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function registryVersions() {
  const response = await fetch(registry, {
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  if (response.status === 404) return {};
  assert.ok(
    response.ok,
    `Registry lookup failed with HTTP ${response.status}. No release state was assumed.`,
  );
  const metadata = await response.json();
  assert.equal(metadata.name, packageName, 'Registry returned a different package');
  assert.ok(
    metadata.versions && typeof metadata.versions === 'object' && !Array.isArray(metadata.versions),
    'Registry returned invalid version metadata',
  );
  return metadata.versions;
}

function refresh() {
  git('fetch', '--no-recurse-submodules', 'origin', 'main', '--tags');
  return sha(git('rev-parse', 'refs/remotes/origin/main'));
}

function remoteTag(tag) {
  const ref = `refs/tags/${tag}`;
  const entries = git('ls-remote', '--tags', 'origin', ref, `${ref}^{}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  return (
    entries.find(([, name]) => name === `${ref}^{}`)?.[0] ??
    entries.find(([, name]) => name === ref)?.[0]
  );
}

function intent(commit) {
  const message = git('show', '-s', '--format=%B', commit);
  const get = (name) =>
    message
      .split('\n')
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2);
  const version = get('R2D1-Release-Version');
  const runId = get('R2D1-Release-Run');
  const base = get('R2D1-Release-Base');
  if (!stable(version) || !/^\d+$/.test(runId ?? '') || !/^[0-9a-f]{40}$/.test(base ?? ''))
    return undefined;
  return { version, runId, base, sha: sha(commit), tag: `v${version}` };
}

function inventory() {
  const names = git('tag', '--list', 'v*').split('\n').filter(Boolean);
  const tags = names
    .filter((name) => stable(name.slice(1)))
    .map((tag) => {
      const commit = sha(git('rev-parse', `refs/tags/${tag}^{commit}`));
      const release = intent(commit);
      return { ...(release ?? {}), tag, version: tag.slice(1), sha: commit };
    });
  const candidates = git(
    'log',
    '-100',
    '--format=%H',
    '--fixed-strings',
    '--grep=R2D1-Release-Version:',
    'origin/main',
  )
    .split('\n')
    .filter(Boolean);
  const untagged = candidates.map(intent).filter((value) => value && !names.includes(value.tag));
  return { tags, untagged };
}

function validateReleaseSource(commit, version) {
  sha(commit);
  assert.ok(stable(version) && compare(version, '1.0.0') >= 0, 'Invalid formal release version');
  git('merge-base', '--is-ancestor', commit, 'origin/main');
  const marker = intent(commit);
  assert.equal(marker?.version, version, 'Selected source is not an automation release commit');
  assert.equal(
    git('rev-parse', `${commit}^`),
    marker.base,
    'Release base is not the commit parent',
  );
  const changed = git('diff', '--name-only', marker.base, commit)
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    changed,
    ['package-lock.json', 'package.json'],
    'Release commit must change only version files',
  );
  const manifest = JSON.parse(git('show', `${commit}:package.json`));
  const lock = JSON.parse(git('show', `${commit}:package-lock.json`));
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, version);
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(lock.packages[''].name, packageName);
}

async function planRelease() {
  assert.equal(git('status', '--porcelain'), '', 'Release checkout must be clean');
  const main = refresh();
  const versions = await registryVersions();
  const selected = selectRelease({
    published: Object.keys(versions),
    ...inventory(),
    runId: process.env.GITHUB_RUN_ID,
    resumeTag: process.env.RESUME_TAG ?? '',
  });
  const sourceSha = selected.mode === 'new' ? main : selected.sha;
  if (selected.mode !== 'new') validateReleaseSource(sourceSha, selected.version);
  const plan = { ...selected, sourceSha, main, runId: process.env.GITHUB_RUN_ID };
  await writeFile(planPath(), JSON.stringify(plan, null, 2) + '\n');
  await output({ version: plan.version, tag: plan.tag, mode: plan.mode });
  console.log(`Selected ${plan.tag}: ${plan.mode}, source ${sourceSha}`);
}

async function stageVersion() {
  const plan = await json(planPath());
  git('checkout', '--detach', sha(plan.sourceSha));
  const manifest = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(manifest.name, packageName);
  assert.equal(lock.packages[''].name, packageName);
  if (plan.mode !== 'new') {
    assert.equal(manifest.version, plan.version);
    assert.equal(lock.version, plan.version);
    assert.equal(lock.packages[''].version, plan.version);
    return;
  }
  if (stable(manifest.version))
    assert.ok(compare(manifest.version, plan.version) <= 0, 'Refusing a package version downgrade');
  manifest.version = plan.version;
  lock.version = plan.version;
  lock.packages[''].version = plan.version;
  await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n');
  await writeFile('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}

async function reserveRelease() {
  const plan = await json(planPath());
  assert.equal(plan.runId, process.env.GITHUB_RUN_ID, 'Plan belongs to another workflow run');
  const main = refresh();
  const versions = await registryVersions();
  let commit = plan.sourceSha;
  if (plan.mode === 'new') {
    assert.equal(
      main,
      plan.main,
      'main advanced during validation. Dispatch again and validate the new main.',
    );
    assert.equal(git('rev-parse', 'HEAD'), plan.sourceSha);
    const selection = selectRelease({
      published: Object.keys(versions),
      ...inventory(),
      runId: plan.runId,
    });
    assert.equal(
      selection.mode,
      'new',
      'Release state changed during validation. Re-plan before reserving.',
    );
    assert.equal(
      selection.version,
      plan.version,
      'Version became occupied during validation. Re-plan.',
    );
    const changed = git('diff', '--name-only').split('\n').filter(Boolean).sort();
    assert.deepEqual(
      changed,
      ['package-lock.json', 'package.json'],
      'Only version files may change',
    );
    assert.equal(git('diff', '--cached', '--name-only'), '', 'Unexpected staged files');
    // Verify that the staged change can contain only these three version values.
    for (const file of changed) {
      const before = JSON.parse(git('show', `HEAD:${file}`));
      const after = await json(file);
      before.version = plan.version;
      if (file === 'package-lock.json') before.packages[''].version = plan.version;
      assert.deepEqual(after, before, `Unexpected non-version change in ${file}`);
    }
    git('add', '--', 'package.json', 'package-lock.json');
    git('diff', '--cached', '--check');
    const message = join(process.env.RUNNER_TEMP, 'r2d1-release-message.txt');
    await writeFile(
      message,
      `chore(release): ${plan.tag}\n\nR2D1-Release-Version: ${plan.version}\nR2D1-Release-Run: ${plan.runId}\nR2D1-Release-Base: ${plan.sourceSha}\n`,
    );
    git(
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '--file',
      message,
    );
    commit = sha(git('rev-parse', 'HEAD'));
  } else {
    assert.equal(git('status', '--porcelain'), '', 'Recovery source changed during validation');
    assert.equal(git('rev-parse', 'HEAD'), commit, 'Recovery checkout changed during validation');
    validateReleaseSource(commit, plan.version);
    if (plan.mode === 'repair')
      assert.ok(
        !versions[plan.version],
        'npm already has this untagged version. Verify its original artifact before manually restoring the missing tag.',
      );
  }
  const tagRef = `refs/tags/${plan.tag}`;
  const existing = inventory().tags.find((tag) => tag.tag === plan.tag);
  if (existing) assert.equal(existing.sha, commit, 'Tag points to another commit. Never move it.');
  else {
    git('tag', plan.tag, commit);
    const refspecs = plan.mode === 'new' ? [`${commit}:refs/heads/main`, tagRef] : [tagRef];
    try {
      git('push', '--atomic', 'origin', ...refspecs);
    } catch (error) {
      // A lost push response does not prove failure. Reconcile the remote before deciding.
      const refs = git('ls-remote', 'origin', 'refs/heads/main', tagRef).split('\n');
      assert.ok(
        refs.includes(`${commit}\t${tagRef}`),
        'Atomic push was not confirmed. No npm publication is allowed. Re-run all jobs or inspect remote refs.',
      );
      console.log(
        `Push returned an error but the exact remote tag exists: ${error.message.split('\n')[0]}`,
      );
    }
  }
  refresh();
  assert.equal(sha(git('rev-parse', `${tagRef}^{commit}`)), commit);
  assert.equal(remoteTag(plan.tag), commit, 'The exact remote release tag was not confirmed');
  validateReleaseSource(commit, plan.version);
  assert.equal(git('rev-parse', 'HEAD'), commit);
  await output({
    version: plan.version,
    tag: plan.tag,
    sha: commit,
    artifact: `npm-package-${plan.runId}-${process.env.GITHUB_RUN_ATTEMPT}`,
  });
  console.log(`Reserved ${plan.tag} at ${commit}. This command did not publish to npm.`);
}

function verifySource() {
  refresh();
  const commit = sha(process.env.RELEASE_SHA ?? '');
  assert.equal(process.env.RELEASE_TAG, `v${process.env.RELEASE_VERSION}`);
  assert.equal(git('rev-parse', 'HEAD'), commit, 'Publish checkout is not the reserved commit');
  assert.equal(remoteTag(process.env.RELEASE_TAG), commit, 'Remote tag changed');
  validateReleaseSource(commit, process.env.RELEASE_VERSION);
}

requireWorkflow();
switch (process.argv[2]) {
  case 'plan':
    await planRelease();
    break;
  case 'stage':
    await stageVersion();
    break;
  case 'reserve':
    await reserveRelease();
    break;
  case 'verify-source':
    verifySource();
    break;
  case 'status':
  case 'confirm': {
    const { runPublicationCommand } = await import('./npm-publication.mjs');
    await runPublicationCommand(process.argv[2]);
    break;
  }
  default:
    throw new Error('Expected plan, stage, reserve, verify-source, status, or confirm');
}
