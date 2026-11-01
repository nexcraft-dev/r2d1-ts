import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { R2D1, defineSchema, decodeCursor, StorageOperationError } from '../dist/index.js';
import { D1IndexStore } from '../dist/storage/d1.js';
import { schema, user, codec, MemoryDocuments, sqlite } from './support.mjs';

test('original Java-generated DDL and upserts are readable by TypeScript and Java SQL reads TypeScript rows', async () => {
  const fixtures = JSON.parse(
    await readFile(new URL('./fixtures/java.json', import.meta.url), 'utf8'),
  );
  const { db, indexes } = sqlite();
  try {
    for (const statement of fixtures.statements.filter((s) => s.kind === 'schema'))
      db.exec(statement.sql);
    const upsert = fixtures.statements.find((s) => s.kind === 'upsert');
    db.prepare(upsert.sql).run(...upsert.params);
    const schema = defineSchema({
      collection: 'r2d1_it_persistence_v1',
      id: 'id',
      indexes: { country: 'string', rank: 'long' },
    });
    await indexes.initialize(schema.metadata);
    await indexes.upsert(schema.entry({ id: 'ts-max', country: 'NZ', rank: (1n << 63n) - 1n }));
    const first = await indexes.query({
      collection: schema.metadata.collection,
      filters: [],
      sort: { field: 'rank', direction: 'ASC' },
      limit: 1,
    });
    assert.equal(first.documentKeys[0].id, 'user/한글');
    assert.equal(first.nextCursor.sortValue.value, -(1n << 63n));
    const query = fixtures.statements.find((s) => s.kind === 'query');
    const statement = db.prepare(query.sql);
    statement.setReadBigInts(true);
    const rows = statement.all(...query.params);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].document_id, 'ts-max');
    assert.equal(rows[0].rank, (1n << 63n) - 1n);
  } finally {
    db.close();
  }
});

test('Long pagination uses numeric order for 2 and 10 despite a text cursor projection', async () => {
  const { db, indexes } = sqlite();
  try {
    const collection = await new R2D1(new MemoryDocuments(), indexes).collection(schema, codec);
    for (const [id, rank] of [
      ['two', 2n],
      ['ten', 10n],
      ['one', 1n],
      ['negative_two', -2n],
      ['negative_ten', -10n],
    ]) {
      await collection.put(user(id, rank));
    }
    for (const direction of ['ASC', 'DESC']) {
      const ids = [];
      let cursor;
      do {
        let query = collection.query().sortBy('rank', direction).limit(1);
        if (cursor) query = query.after(cursor);
        const page = await query.fetch();
        ids.push(...page.items.map((value) => value.id));
        cursor = page.nextCursor;
      } while (cursor);
      const expected = ['negative_ten', 'negative_two', 'one', 'two', 'ten'];
      assert.deepEqual(ids, direction === 'ASC' ? expected : expected.reverse());
    }
  } finally {
    db.close();
  }
});

test('SQLite numeric keyset pagination preserves the full Long range and sort ties in both directions', async () => {
  const { db, indexes } = sqlite();
  try {
    const collection = await new R2D1(new MemoryDocuments(), indexes).collection(schema, codec);
    const values = [
      user('min', -(1n << 63n)),
      user('a', 7n),
      user('b', 7n),
      user('max', (1n << 63n) - 1n),
    ];
    for (const value of values) await collection.put(value);
    assert.deepEqual(
      db
        .prepare('select typeof(rank) t from users')
        .all()
        .map((r) => r.t),
      ['integer', 'integer', 'integer', 'integer'],
    );
    for (const direction of ['ASC', 'DESC']) {
      const expected = direction === 'ASC' ? ['min', 'a', 'b', 'max'] : ['max', 'b', 'a', 'min'];
      const ids = [];
      let cursor;
      do {
        let query = collection.query().sortBy('rank', direction).limit(1);
        if (cursor) query = query.after(cursor);
        const page = await query.fetch();
        ids.push(...page.items.map((v) => v.id));
        cursor = page.nextCursor;
        if (cursor) assert.equal(decodeCursor(cursor).sortValue.value, page.items[0].rank);
      } while (cursor);
      assert.deepEqual(ids, expected);
    }
    for (const [method, expected] of [
      ['eq', ['a', 'b']],
      ['notEq', ['max', 'min']],
      ['gt', ['max']],
      ['gte', ['a', 'b', 'max']],
      ['lt', ['min']],
      ['lte', ['a', 'b', 'min']],
    ]) {
      assert.deepEqual(
        (await collection.query().where('rank')[method](7n).limit(10).fetch()).items.map(
          (v) => v.id,
        ),
        expected,
      );
    }
    assert.equal(
      (await collection.query().where('country').eq("NZ' OR 1=1 --").limit(10).fetch()).items
        .length,
      0,
    );
  } finally {
    db.close();
  }
});

test('string, double and boolean sorting use deterministic ID ties and AND comparisons', async () => {
  const { db, indexes } = sqlite();
  try {
    const collection = await new R2D1(new MemoryDocuments(), indexes).collection(schema, codec);
    for (const id of ['c', 'b', 'a']) await collection.put(user(id));
    for (const field of ['country', 'score', 'active']) {
      const first = await collection.query().sortBy(field, 'DESC').limit(2).fetch();
      const last = await collection
        .query()
        .sortBy(field, 'DESC')
        .limit(2)
        .after(first.nextCursor)
        .fetch();
      assert.deepEqual(
        [...first.items, ...last.items].map((v) => v.id),
        ['c', 'b', 'a'],
      );
      assert.equal(last.nextCursor, undefined);
    }
    assert.equal(
      (
        await collection
          .query()
          .where('active')
          .eq(true)
          .where('score')
          .gte(1)
          .where('country')
          .notEq('AU')
          .limit(10)
          .fetch()
      ).items.length,
      3,
    );
    assert.equal(
      (await collection.query().where('active').notEq(true).limit(10).fetch()).items.length,
      0,
    );
    const first = await collection.query().limit(2).fetch();
    assert.deepEqual(
      (await collection.query().limit(2).after(first.nextCursor).fetch()).items.map((v) => v.id),
      ['c'],
    );
  } finally {
    db.close();
  }
});

test('schema initialization accepts Java table/index layout and preserves extra schema', async () => {
  const { db, indexes } = sqlite();
  try {
    db.exec(
      'CREATE TABLE users (document_id TEXT PRIMARY KEY NOT NULL, active INTEGER NOT NULL, country TEXT NOT NULL, rank INTEGER NOT NULL, score REAL NOT NULL, old TEXT); CREATE INDEX idx_users_country ON users(country); CREATE INDEX retained_index ON users(old)',
    );
    await indexes.initialize(schema.metadata);
    const columns = db.prepare('PRAGMA table_info(users)').all();
    assert.equal(columns.length, 6);
    assert.equal(columns.find((c) => c.name === 'rank').type, 'INTEGER');
    assert.ok(
      db
        .prepare('PRAGMA index_list(users)')
        .all()
        .some((i) => i.name === 'retained_index'),
    );
    await indexes.upsert(schema.entry(user()));
    await indexes.clear('users');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
    assert.equal(db.prepare('PRAGMA table_info(users)').all().length, 6);
  } finally {
    db.close();
  }
});

test('safe empty-table additions succeed but populated-table additions and incompatible schemas fail', async () => {
  const simple = defineSchema({ collection: 'users', id: 'id', indexes: { country: 'string' } });
  for (const populated of [false, true]) {
    const { db, indexes, transport } = sqlite();
    try {
      await indexes.initialize(simple.metadata);
      if (populated) await indexes.upsert(simple.entry({ id: 'a', country: 'NZ' }));
      const next = new D1IndexStore(transport);
      if (populated) {
        await assert.rejects(next.initialize(schema.metadata), /rebuild/);
        assert.equal(db.prepare('PRAGMA table_info(users)').all().length, 2);
        await assert.rejects(next.initialize(schema.metadata), /rebuild/);
      } else {
        await next.initialize(schema.metadata);
        assert.equal(db.prepare('PRAGMA table_info(users)').all().length, 5);
      }
    } finally {
      db.close();
    }
  }
  for (const ddl of [
    'CREATE TABLE users (document_id TEXT PRIMARY KEY, country TEXT NOT NULL)',
    'CREATE TABLE users (document_id TEXT PRIMARY KEY NOT NULL, country INTEGER NOT NULL)',
    'CREATE TABLE users (document_id TEXT PRIMARY KEY NOT NULL, country TEXT NOT NULL, old TEXT); CREATE INDEX idx_users_country ON users(old)',
    'CREATE TABLE users (document_id TEXT PRIMARY KEY NOT NULL, country TEXT NOT NULL); CREATE TABLE other(x TEXT); CREATE INDEX idx_users_country ON other(x)',
  ]) {
    const { db, indexes } = sqlite();
    try {
      db.exec(ddl);
      await assert.rejects(indexes.initialize(simple.metadata), StorageOperationError);
    } finally {
      db.close();
    }
  }
});

test('same-schema initialization shares I/O, conflicts fail, and failed initialization is retained', async () => {
  const { db, indexes, statements, transport } = sqlite();
  try {
    await Promise.all([indexes.initialize(schema.metadata), indexes.initialize(schema.metadata)]);
    assert.equal(statements.filter((s) => s.sql.startsWith('CREATE TABLE')).length, 1);
    await assert.rejects(
      indexes.initialize({ ...schema.metadata, fields: [] }),
      /different metadata/,
    );
    await assert.rejects(
      new D1IndexStore(transport).query({ collection: 'users', filters: [], limit: 1 }),
      /not initialized/,
    );
    let calls = 0;
    const failed = new D1IndexStore({
      execute: async () => {
        calls++;
        throw new Error('schema failed');
      },
    });
    await assert.rejects(failed.initialize(schema.metadata), /schema failed/);
    await assert.rejects(failed.initialize(schema.metadata), /schema failed/);
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});

test('cursor shape, collection and value types are rejected before query I/O', async () => {
  const { db, indexes, statements } = sqlite();
  try {
    await indexes.initialize(schema.metadata);
    const count = statements.length;
    const query = { collection: 'users', filters: [], limit: 1 };
    for (const extra of [
      { cursor: { lastDocumentKey: { collection: 'other', id: 'a' } } },
      {
        cursor: {
          lastDocumentKey: { collection: 'users', id: 'a' },
          sortValue: { type: 'long', value: 1n },
        },
      },
      {
        sort: { field: 'rank', direction: 'ASC' },
        cursor: { lastDocumentKey: { collection: 'users', id: 'a' } },
      },
      { filters: [{ field: 'rank', operator: '=', value: { type: 'double', value: 1 } }] },
      {
        filters: [{ field: 'country', operator: 'OR 1=1', value: { type: 'string', value: 'NZ' } }],
      },
    ])
      await assert.rejects(indexes.query({ ...query, ...extra }));
    assert.equal(statements.length, count);
  } finally {
    db.close();
  }
});
