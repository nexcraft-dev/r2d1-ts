import test from 'node:test';
import assert from 'node:assert/strict';
import {
  R2D1,
  StoredDocument,
  DocumentNotFoundError,
  StorageAccessError,
  StorageOperationError,
  StorageUnavailableError,
} from '../dist/index.js';
import { NodeD1IndexStore, NodeR2DocumentStore } from '../dist/node/index.js';
import { WorkersR2DocumentStore, WorkersD1IndexStore } from '../dist/workers/index.js';
import { MemoryDocuments, sqlite, schema, codec, user } from './support.mjs';

test('Node D1 REST serializes one bound statement, preserves Longs and encodes endpoint segments', async () => {
  const { db, transport } = sqlite();
  const requests = [];
  try {
    const indexes = new NodeD1IndexStore({
      accountId: 'account/a',
      databaseId: 'database b',
      apiToken: 'test-token',
      fetch: async (url, init) => {
        requests.push({ url, init });
        const body = JSON.parse(init.body);
        const result = await transport.execute({ sql: body.sql, params: body.params });
        return Response.json({ success: true, result: [{ success: true, results: result.rows }] });
      },
    });
    const collection = await new R2D1(new MemoryDocuments(), indexes).collection(schema, codec);
    await collection.put(user('a', -(1n << 63n)));
    await collection.put(user('b', (1n << 63n) - 1n));
    const page = await collection.query().sortBy('rank').limit(1).fetch();
    assert.equal(page.items[0].rank, -(1n << 63n));
    assert.equal(
      (await collection.query().sortBy('rank').limit(1).after(page.nextCursor).fetch()).items[0]
        .rank,
      (1n << 63n) - 1n,
    );
    assert.equal(
      requests[0].url,
      'https://api.cloudflare.com/client/v4/accounts/account%2Fa/d1/database/database%20b/query',
    );
    assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token');
    assert.equal(requests[0].init.redirect, 'error');
    assert.ok(requests.some((r) => r.init.body.includes('-9223372036854775808')));
  } finally {
    db.close();
  }
});

test('D1 REST classifies status and protocol failures without exposing tokens or server text', async () => {
  const secret = 'token-must-not-leak';
  for (const [response, expected] of [
    [() => new Response(secret, { status: 401 }), StorageAccessError],
    [() => new Response(secret, { status: 403 }), StorageAccessError],
    [() => new Response(secret, { status: 429 }), StorageUnavailableError],
    [() => new Response(secret, { status: 503 }), StorageUnavailableError],
    [() => new Response(secret, { status: 400 }), StorageOperationError],
    [() => new Response(secret), StorageOperationError],
    [() => Response.json({ success: false, errors: [{ message: secret }] }), StorageOperationError],
    [
      () => Response.json({ success: true, result: [{ success: false, error: secret }] }),
      StorageOperationError,
    ],
    [
      () => Response.json({ success: true, result: [{ success: true, results: [null] }] }),
      StorageOperationError,
    ],
    [
      () => {
        throw new Error(secret);
      },
      StorageUnavailableError,
    ],
  ]) {
    const indexes = new NodeD1IndexStore({
      accountId: 'a',
      databaseId: 'b',
      apiToken: secret,
      fetch: async () => response(),
    });
    await assert.rejects(
      indexes.initialize(schema.metadata),
      (error) =>
        error instanceof expected && !error.stack.includes(secret) && error.cause === undefined,
    );
  }
});

test('D1 REST cancels unread error response bodies so connections are released', async () => {
  for (const status of [401, 403, 429, 503, 400]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('ignored'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const indexes = new NodeD1IndexStore({
      accountId: 'a',
      databaseId: 'b',
      apiToken: 'token',
      fetch: async () => new Response(body, { status }),
    });
    await assert.rejects(indexes.initialize(schema.metadata), (error) => {
      return error.name.startsWith('Storage') && error.message.includes(String(status));
    });
    assert.equal(cancelled, true, `body was not cancelled for HTTP ${status}`);
  }
});

test('Node R2 uses canonical SDK commands, exact bytes, opaque listing cursors and borrowed ownership', async () => {
  const commands = [];
  let destroyed = 0;
  let fail;
  const client = {
    destroy: () => {
      destroyed++;
    },
    send: async (command) => {
      commands.push(command);
      if (fail) throw fail;
      if (command.constructor.name === 'GetObjectCommand')
        return { Body: { transformToByteArray: async () => new Uint8Array([0, 255, 1]) } };
      if (command.constructor.name === 'ListObjectsV2Command')
        return {
          Contents: [{ Key: 'users/a%2Fb' }],
          IsTruncated: true,
          NextContinuationToken: 'opaque',
        };
      return {};
    },
  };
  const store = new NodeR2DocumentStore({ client, bucket: 'bucket' });
  const key = { collection: 'users', id: 'a/b' };
  await store.put(key, new StoredDocument(new Uint8Array([0, 255, 1])));
  assert.equal(commands[0].input.Key, 'users/a%2Fb');
  assert.deepEqual([...commands[0].input.Body], [0, 255, 1]);
  assert.deepEqual([...(await store.get(key)).content()], [0, 255, 1]);
  assert.deepEqual(await store.list('users', 'previous', 1), {
    documentKeys: [key],
    nextCursor: 'opaque',
  });
  assert.equal(commands.at(-1).input.ContinuationToken, 'previous');
  fail = Object.assign(new Error('sensitive transport detail'), {
    $metadata: { httpStatusCode: 404 },
  });
  await assert.rejects(store.get(key), DocumentNotFoundError);
  await store.delete(key);
  fail = Object.assign(new Error('sensitive transport detail'), {
    $metadata: { httpStatusCode: 403 },
  });
  await assert.rejects(
    store.put(key, new StoredDocument(new Uint8Array())),
    (error) => error instanceof StorageAccessError && !error.stack.includes('sensitive'),
  );
  store.close();
  store.close();
  assert.equal(destroyed, 0);
  const owned = new NodeR2DocumentStore({
    bucket: 'bucket',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  });
  owned.close();
  owned.close();
  assert.throws(
    () =>
      new NodeR2DocumentStore({
        bucket: 'x',
        endpoint: 'http://example.com',
        accessKeyId: 'x',
        secretAccessKey: 'x',
      }),
    /HTTPS/,
  );
});

test('R2 adapters reject invalid listings and native operational errors remain secret-safe', async () => {
  const node = new NodeR2DocumentStore({
    bucket: 'b',
    client: { send: async () => ({ IsTruncated: true, Contents: [] }) },
  });
  await assert.rejects(node.list('users', undefined, 1), StorageOperationError);
  const native = new WorkersR2DocumentStore({
    list: async () => ({ objects: [], truncated: true }),
    get: async () => null,
    delete: async () => {
      throw new Error('binding-secret');
    },
    put: async () => {
      throw new Error('binding-secret');
    },
  });
  await assert.rejects(native.list('users', undefined, 1), StorageOperationError);
  await assert.rejects(native.get({ collection: 'users', id: 'x' }), DocumentNotFoundError);
  await assert.rejects(
    native.put({ collection: 'users', id: 'x' }, new StoredDocument(new Uint8Array())),
    (error) => error instanceof StorageOperationError && !error.stack.includes('binding-secret'),
  );
  const indexes = new WorkersD1IndexStore({
    prepare: () => {
      throw new Error('binding-secret');
    },
  });
  await assert.rejects(
    indexes.initialize(schema.metadata),
    (error) => error instanceof StorageOperationError && !error.stack.includes('binding-secret'),
  );
});
