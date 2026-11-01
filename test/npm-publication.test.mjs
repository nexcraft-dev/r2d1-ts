import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  confirmPublished,
  shouldPublish,
  confirmationTimeoutMs,
} from '../scripts/npm-publication.mjs';

const target = { version: '1.0.0', integrity: 'sha512-expected', sha: 'a'.repeat(40) };
const metadata = (extra = {}) => ({
  name: '@nexcraft-dev/r2d1',
  version: '1.0.0',
  dist: { integrity: target.integrity },
  ...extra,
});
const visible = () => Response.json(metadata());
function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
  };
}

test('confirmation survives a five-minute npm processing delay without real waiting', async () => {
  const timer = clock();
  let reads = 0;
  const result = await confirmPublished(target, {
    ...timer,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://registry.npmjs.org/@nexcraft-dev%2fr2d1/1.0.0');
      reads++;
      return timer.now() < 300_000 ? new Response('', { status: 404 }) : visible();
    },
  });
  assert.equal(result.version, '1.0.0');
  assert.equal(timer.now(), 300_000);
  assert.equal(reads, 21);
  assert.equal(confirmationTimeoutMs, 1_200_000);
});

test('confirmation retries transient HTTP, network and interrupted body failures', async () => {
  const timer = clock();
  let reads = 0;
  const responses = [
    () => {
      throw new TypeError('network');
    },
    () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }),
    () => new Response('', { status: 503 }),
    () => new Response('{truncated'),
    () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('body aborted');
      },
    }),
    visible,
  ];
  await confirmPublished(target, { ...timer, fetchImpl: async () => responses[reads++]() });
  assert.equal(reads, 6);
  assert.equal(timer.now(), 90_000);
});

test('confirmation has an absolute deadline and does not claim an absent version succeeded', async () => {
  const timer = clock();
  let reads = 0;
  await assert.rejects(
    confirmPublished(target, {
      ...timer,
      timeoutMs: 31_000,
      fetchImpl: async () => {
        reads++;
        return new Response('', { status: 404 });
      },
    }),
    /may still be processing/,
  );
  assert.equal(timer.now(), 31_000);
  assert.equal(reads, 3);
});

test('authentication and immutable artifact mismatches fail without retrying', async () => {
  for (const response of [
    () => new Response('', { status: 403 }),
    () => Response.json(metadata({ name: 'wrong-package' })),
    () => Response.json(metadata({ version: '1.0.1' })),
    () => Response.json(metadata({ dist: { integrity: 'sha512-wrong' } })),
    () => Response.json(metadata({ gitHead: 'b'.repeat(40) })),
  ]) {
    let reads = 0;
    await assert.rejects(
      confirmPublished(target, {
        ...clock(),
        fetchImpl: async () => {
          reads++;
          return response();
        },
      }),
    );
    assert.equal(reads, 1);
  }
});

test('pre-publication checks never treat transient failure as absence', async () => {
  assert.equal(
    await shouldPublish(target, { fetchImpl: async () => new Response('', { status: 404 }) }),
    true,
  );
  assert.equal(await shouldPublish(target, { fetchImpl: async () => visible() }), false);
  await assert.rejects(
    shouldPublish(target, { fetchImpl: async () => new Response('', { status: 503 }) }),
    /uncertain/,
  );
  await assert.rejects(
    shouldPublish(target, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    /uncertain/,
  );
});

test('the workflow preserves current confirmation logic before checkout of an older package tag', async () => {
  const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  const controllerCheckout = publish.indexOf('ref: ${{ github.sha }}');
  const preserve = publish.indexOf('cp scripts/npm-publication.mjs');
  const packageCheckout = publish.indexOf('ref: ${{ needs.prepare.outputs.sha }}');
  assert.ok(controllerCheckout >= 0 && preserve > controllerCheckout && packageCheckout > preserve);
  assert.ok(publish.includes('node "$RUNNER_TEMP/r2d1-npm-publication.mjs" status'));
  assert.ok(publish.includes('node "$RUNNER_TEMP/r2d1-npm-publication.mjs" confirm'));
});
