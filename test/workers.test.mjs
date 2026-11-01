import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';

test('Workerd native R2/D1 bindings support exact int64 CRUD, pagination, stale errors and recovery', async () => {
  const bundle = await build({
    entryPoints: ['test/fixtures/worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(bundle.metafile.inputs).every(
      (path) => !path.includes('node_modules') && !path.includes('src/node/'),
    ),
  );
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30',
    r2Buckets: ['BUCKET'],
    d1Databases: ['DB'],
  });
  try {
    const call = async (path, options) => {
      const response = await mf.dispatchFetch('https://test' + path, options);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    };
    for (const [id, rank] of [
      ['min', '-9223372036854775808'],
      ['two', '2'],
      ['a', '7'],
      ['b', '7'],
      ['ten', '10'],
      ['max', '9223372036854775807'],
    ])
      await call('/put', { method: 'POST', body: JSON.stringify({ id, rank, country: 'NZ' }) });
    assert.equal((await call('/get?id=min')).rank, '-9223372036854775808');
    const bucket = await mf.getR2Bucket('BUCKET');
    assert.equal(
      JSON.parse(await (await bucket.get('users/max')).text()).rank,
      '9223372036854775807',
    );
    for (const direction of ['ASC', 'DESC']) {
      const ids = [];
      let cursor;
      do {
        const page = await call(
          '/query?direction=' + direction + (cursor ? '&cursor=' + cursor : ''),
        );
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(
        ids,
        direction === 'ASC'
          ? ['min', 'two', 'a', 'b', 'ten', 'max']
          : ['max', 'ten', 'b', 'a', 'two', 'min'],
      );
    }
    await bucket.delete('users/min');
    const inconsistent = await mf.dispatchFetch('https://test/query');
    assert.equal(inconsistent.status, 500);
    assert.equal((await inconsistent.json()).name, 'InconsistentStateError');
    await call('/rebuild');
    assert.equal((await call('/query')).items[0].id, 'two');
    await call('/delete?id=a');
    await call('/delete?id=a');
    assert.equal(await call('/get?id=a'), null);
    const db = await mf.getD1Database('DB');
    assert.equal(
      (
        await db
          .prepare('SELECT typeof(rank) t FROM users WHERE document_id = ?')
          .bind('max')
          .first()
      ).t,
      'integer',
    );
    assert.deepEqual(
      (await db.prepare('PRAGMA table_info(users)').all()).results.map((r) => [r.name, r.type]),
      [
        ['document_id', 'TEXT'],
        ['country', 'TEXT'],
        ['rank', 'INTEGER'],
      ],
    );
  } finally {
    await mf.dispose();
  }
});
