import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const confirmationTimeoutMs = 20 * 60 * 1000;
const packageName = '@nexcraft-dev/r2d1';

function retryAfter(response) {
  const header = response.headers.get('retry-after');
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

/** Read the exact version endpoint. A network failure is never an absent version. */
export async function lookupVersion(version, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  let response;
  try {
    response = await fetchImpl(`https://registry.npmjs.org/@nexcraft-dev%2fr2d1/${version}`, {
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
  } catch {
    return { state: 'retry', reason: 'Registry request failed or timed out', retryAfterMs: 0 };
  }
  if (response.status === 404) return { state: 'missing', reason: 'Version is not visible yet' };
  if (response.status === 429 || response.status >= 500) {
    return {
      state: 'retry',
      reason: `Registry HTTP ${response.status}`,
      retryAfterMs: retryAfter(response),
    };
  }
  assert.ok(response.ok, `Registry request rejected with HTTP ${response.status}`);
  let metadata;
  try {
    metadata = await response.json();
  } catch {
    return {
      state: 'retry',
      reason: 'Registry response body was interrupted or invalid',
      retryAfterMs: 0,
    };
  }
  return { state: 'visible', metadata };
}

export function verifyPublished(metadata, { version, integrity, sha }) {
  assert.ok(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata),
    'Invalid registry metadata',
  );
  assert.equal(metadata.name, packageName, 'Registry package name differs');
  assert.equal(metadata.version, version, 'Registry version differs');
  assert.equal(
    metadata.dist?.integrity,
    integrity,
    'Published tarball integrity differs. Never overwrite or retag this version.',
  );
  if (metadata.gitHead)
    assert.equal(metadata.gitHead, sha, 'Published gitHead differs from the reserved SHA');
  return metadata;
}

export async function shouldPublish(target, options) {
  const result = await lookupVersion(target.version, options);
  if (result.state === 'missing') return true;
  assert.notEqual(result.state, 'retry', 'Registry state is uncertain. Stop before publication.');
  verifyPublished(result.metadata, target);
  return false;
}

/** npm can accept an upload before its publish-time scan makes the version available. */
export async function confirmPublished(
  target,
  {
    fetchImpl = fetch,
    now = () => performance.now(),
    wait = sleep,
    timeoutMs = confirmationTimeoutMs,
    intervalMs = 15_000,
    onWait = () => {},
  } = {},
) {
  assert.ok(timeoutMs > 0 && intervalMs > 0, 'Confirmation durations must be positive');
  const start = now();
  const deadline = start + timeoutMs;
  while (now() < deadline) {
    const result = await lookupVersion(target.version, {
      fetchImpl,
      timeoutMs: Math.min(15_000, deadline - now()),
    });
    if (result.state === 'visible') return verifyPublished(result.metadata, target);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    onWait({ elapsedMs: now() - start, remainingMs, reason: result.reason });
    await wait(Math.min(Math.max(intervalMs, result.retryAfterMs ?? 0), remainingMs));
  }
  throw new Error(
    'Registry confirmation timed out after 20 minutes. The upload may still be processing. Keep the tag and artifact; check this version without publishing again.',
  );
}

export async function runPublicationCommand(command) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  assert.equal(process.env.GITHUB_REPOSITORY, 'nexcraft-dev/r2d1-ts');
  assert.ok(process.env.GITHUB_OUTPUT, 'Missing workflow output file');
  assert.ok(['status', 'confirm'].includes(command), 'Expected status or confirm');
  // This command validates the immutable source but never changes Git refs.
  execFileSync(process.execPath, ['scripts/release.mjs', 'verify-source'], { stdio: 'inherit' });
  const version = process.env.RELEASE_VERSION;
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const bytes = await readFile(resolve('release', `nexcraft-dev-r2d1-${version}.tgz`));
  const target = {
    version,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha: process.env.RELEASE_SHA,
  };
  if (command === 'status') {
    const publish = await shouldPublish(target);
    await appendFile(process.env.GITHUB_OUTPUT, `publish=${publish}\n`);
    console.log(
      publish
        ? `Version ${version} is absent from the registry`
        : `Version ${version} already matches the exact artifact`,
    );
    return;
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  try {
    await confirmPublished(target, {
      onWait: (state) =>
        console.log(
          `Waiting for npm processing: ${state.reason}; ${Math.ceil(state.remainingMs / 1000)} seconds remaining`,
        ),
    });
    await appendFile(process.env.GITHUB_OUTPUT, 'publication=confirmed\n');
    if (summary)
      await appendFile(
        summary,
        `\nConfirmed ${packageName}@${version}. Registry integrity matches the reserved artifact.\n`,
      );
    console.log(`Confirmed ${packageName}@${version}: exact registry artifact`);
  } catch (error) {
    if (summary)
      await appendFile(
        summary,
        `\nRegistry confirmation did not complete for ${packageName}@${version}. npm command outcome: ${process.env.NPM_PUBLISH_OUTCOME ?? 'unknown'}. The upload may already be accepted. Preserve the tag and artifact and inspect the registry before retrying publication.\n`,
      );
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runPublicationCommand(process.argv[2]);
}
