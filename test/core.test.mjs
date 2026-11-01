import test from 'node:test';
import assert from 'node:assert/strict';
import {
  R2D1,
  defineSchema,
  StoredDocument,
  jsonCodec,
  PartialFailureError,
  InconsistentStateError,
  AdmissionRejectedError,
  StorageAccessError,
} from '../dist/index.js';
import { schema, user, codec, MemoryDocuments, sqlite, deferred } from './support.mjs';

test('authoritative mutations precede index writes and partial failures retain identity and cause', async () => {
  const documents = new MemoryDocuments();
  const fault = new Error('index unavailable');
  const indexes = {
    initialize: async () => {},
    upsert: async () => {
      assert.equal(documents.data.size, 1);
      throw fault;
    },
    delete: async () => {
      assert.equal(documents.data.size, 0);
      throw fault;
    },
  };
  const collection = await new R2D1(documents, indexes).collection(schema, codec);
  await assert.rejects(
    collection.put(user()),
    (e) => e instanceof PartialFailureError && e.cause === fault && e.documentKey.id === 'a',
  );
  assert.deepEqual(await collection.get('a'), user());
  await assert.rejects(
    collection.delete('a'),
    (e) => e instanceof PartialFailureError && e.cause === fault,
  );
  assert.equal(await collection.get('a'), undefined);
});

test('authoritative and codec failures never touch the index', async () => {
  const documents = new MemoryDocuments();
  let writes = 0;
  const indexes = {
    initialize: async () => {},
    upsert: async () => {
      writes++;
    },
    delete: async () => {
      writes++;
    },
  };
  const collection = await new R2D1(documents, indexes).collection(schema, codec);
  await assert.rejects(collection.put({ ...user(), rank: 7 }), /bigint/);
  const fault = new StorageAccessError('denied');
  documents.put = async () => {
    throw fault;
  };
  documents.delete = async () => {
    throw fault;
  };
  documents.get = async () => {
    throw fault;
  };
  await assert.rejects(collection.put(user()), (e) => e === fault);
  await assert.rejects(collection.delete('a'), (e) => e === fault);
  await assert.rejects(collection.get('a'), (e) => e === fault);
  assert.equal(writes, 0);
  assert.deepEqual(documents.events, []);
  const brokenCodec = await new R2D1(documents, indexes).collection(schema, {
    ...codec,
    serialize: () => undefined,
  });
  await assert.rejects(brokenCodec.put(user()), /StoredDocument/);
});

test('immutable queries retain branches, enforce single settings and reject malformed requests', async () => {
  const { db, indexes } = sqlite();
  try {
    const collection = await new R2D1(new MemoryDocuments(), indexes).collection(schema, codec);
    await collection.put(user('a'));
    await collection.put(user('b', 8n));
    const base = collection.query().where('country').eq('NZ');
    assert.deepEqual(
      (await base.where('rank').eq(7n).limit(5).fetch()).items.map((v) => v.id),
      ['a'],
    );
    assert.deepEqual(
      (await base.limit(5).fetch()).items.map((v) => v.id),
      ['a', 'b'],
    );
    await assert.rejects(base.fetch(), /limit/);
    assert.throws(() => base.limit(1).limit(2), /already/);
    assert.throws(() => base.sortBy('rank').sortBy('rank'), /already/);
    assert.throws(() => base.after('x').after('y'), /already/);
    assert.throws(() => base.limit(0), /positive/);
    assert.throws(() => base.where('payload').eq('hello'), /not indexed/);
    assert.throws(() => base.where('active').gt(true), /equality/);
    await assert.rejects(base.limit(1).after('bad').fetch(), /invalid cursor/);
    assert.throws(
      () => defineSchema({ collection: 'bad;DROP', id: 'id', indexes: {} }),
      /identifier/,
    );
    assert.throws(
      () => defineSchema({ collection: 'users', id: 'id', indexes: { document_id: 'string' } }),
      /reserved/,
    );
    assert.throws(
      () =>
        defineSchema({
          collection: 'users',
          id: 'id',
          indexes: { a: 'string', b: 'string', c: 'string', d: 'string', e: 'string', f: 'string' },
        }),
      /five/,
    );
    assert.throws(() => schema.entry({ ...user(), score: NaN }), /double/);
    assert.throws(() => schema.entry({ ...user(), rank: 1n << 63n }), /64-bit/);
    assert.throws(() => schema.entry({ ...user(), id: ' ' }), /nonblank/);
  } finally {
    db.close();
  }
});

test('stale index rows fail the whole page and rebuild removes stale rows without resurrection', async () => {
  const documents = new MemoryDocuments();
  const { db, indexes } = sqlite();
  try {
    const collection = await new R2D1(documents, indexes).collection(schema, codec);
    await collection.put(user('a'));
    await collection.put(user('b'));
    const original = indexes.delete.bind(indexes);
    indexes.delete = async () => {
      throw new Error('fault');
    };
    await assert.rejects(collection.delete('a'), PartialFailureError);
    await assert.rejects(collection.query().limit(10).fetch(), InconsistentStateError);
    indexes.delete = original;
    await documents.put({ collection: 'users', id: 'c' }, codec.serialize(user('c')));
    await collection.rebuildIndex();
    assert.deepEqual(
      (await collection.query().limit(10).fetch()).items.map((v) => v.id),
      ['b', 'c'],
    );
    await collection.rebuildIndex();
    assert.equal((await collection.query().limit(10).fetch()).items.length, 2);
    documents.data.clear();
    await collection.rebuildIndex();
    assert.deepEqual((await collection.query().limit(10).fetch()).items, []);
  } finally {
    db.close();
  }
});

test('rebuild prepares the first page before clearing and preserves rows on preparation failures', async () => {
  for (const phase of ['list', 'get', 'codec', 'identity', 'metadata', 'foreign']) {
    const documents = new MemoryDocuments();
    const { db, indexes } = sqlite();
    try {
      let badCodec = false;
      const collection = await new R2D1(documents, indexes).collection(schema, {
        ...codec,
        deserialize: (value) => {
          if (badCodec) throw new Error('codec fault');
          return codec.deserialize(value);
        },
      });
      await collection.put(user('a'));
      if (phase === 'list')
        documents.list = async () => {
          throw new Error('list fault');
        };
      if (phase === 'get')
        documents.get = async () => {
          throw new Error('get fault');
        };
      if (phase === 'codec') badCodec = true;
      if (phase === 'identity') documents.data.set('users/a', codec.serialize(user('other')));
      if (phase === 'metadata')
        documents.data.set('users/a', codec.serialize({ ...user(), rank: null }));
      if (phase === 'foreign')
        documents.list = async () => ({ documentKeys: [{ collection: 'other', id: 'a' }] });
      await assert.rejects(collection.rebuildIndex());
      assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1, phase);
    } finally {
      db.close();
    }
  }
});

test('rebuild handles multiple bounded pages, preserves other collections, and exposes post-clear failures', async () => {
  const documents = new MemoryDocuments();
  const { db, indexes } = sqlite();
  try {
    const collection = await new R2D1(documents, indexes).collection(schema, codec);
    for (let i = 0; i < 205; i++)
      await documents.put(
        { collection: 'users', id: `u${i}` },
        codec.serialize(user(`u${i}`, BigInt(i))),
      );
    await documents.put({ collection: 'other', id: 'x' }, codec.serialize(user('x')));
    await collection.rebuildIndex();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 205);
    assert.equal(documents.events.filter((e) => e === 'list').length, 3);
    assert.equal(documents.data.has('other/x'), true);
    indexes.upsert = async () => {
      throw new Error('after clear');
    };
    await assert.rejects(collection.rebuildIndex(), /after clear/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  } finally {
    db.close();
  }
});

test('hydration is bounded, preserves index order, and admission waits for in-flight failures to drain', async () => {
  const gates = [deferred(), deferred(), deferred()];
  let started = 0;
  const documents = new MemoryDocuments();
  documents.get = async (key) => {
    const i = Number(key.id);
    started++;
    return gates[i].promise;
  };
  const indexes = {
    initialize: async () => {},
    query: async () => ({
      documentKeys: [0, 1, 2].map((i) => ({ collection: 'users', id: String(i) })),
    }),
  };
  const collection = await new R2D1(documents, indexes).collection(schema, codec, {
    hydrationConcurrency: 2,
    maxConcurrentOperations: 1,
  });
  const page = collection.query().limit(3).fetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 2);
  await assert.rejects(collection.get('0'), AdmissionRejectedError);
  gates[1].resolve(codec.serialize(user('1')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 3);
  gates[2].resolve(codec.serialize(user('2')));
  gates[0].resolve(codec.serialize(user('0')));
  assert.deepEqual(
    (await page).items.map((v) => v.id),
    ['0', '1', '2'],
  );

  const failureGate = deferred(),
    drainGate = deferred();
  let reads = 0;
  documents.get = async () => (++reads === 1 ? failureGate : drainGate).promise;
  const rejected = collection.query().limit(3).fetch();
  const rejection = assert.rejects(rejected, /read fault/);
  await new Promise((resolve) => setImmediate(resolve));
  failureGate.reject(new Error('read fault'));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(collection.get('0'), AdmissionRejectedError);
  drainGate.resolve(codec.serialize(user()));
  await rejection;
  assert.equal(reads, 2);
});

test('byte ownership and opt-in JSON decoder preserve codec boundaries', () => {
  const source = new Uint8Array([0, 255, 1]);
  const stored = new StoredDocument(source);
  source[0] = 7;
  const output = stored.content();
  output[1] = 0;
  assert.deepEqual([...stored.content()], [0, 255, 1]);
  const json = jsonCodec((value) => {
    if (!value || typeof value.id !== 'string') throw new Error('invalid document');
    return value;
  });
  assert.deepEqual(json.deserialize(json.serialize({ id: 'a' })), { id: 'a' });
  assert.throws(
    () => json.deserialize(new StoredDocument(new TextEncoder().encode('{}'))),
    /invalid document/,
  );
  assert.throws(() => json.serialize({ rank: 1n }), /BigInt/);
});
