import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { R2D1, defineSchema, jsonCodec } from '../../dist/index.js';
import { NodeR2DocumentStore, NodeD1IndexStore } from '../../dist/node/index.js';

const enabled = process.env.R2D1_IT_ALLOW_MUTATIONS === 'true';
test(
  'dedicated live Cloudflare R2/D1 round trip',
  { skip: !enabled && 'Set R2D1_IT_ALLOW_MUTATIONS=true and dedicated test credentials' },
  async () => {
    const required = (name) => {
      const value = process.env[name];
      assert.ok(value, `Missing ${name}`);
      return value;
    };
    const documents = new NodeR2DocumentStore({
      endpoint: required('R2D1_IT_R2_ENDPOINT'),
      bucket: required('R2D1_IT_R2_BUCKET_NAME'),
      accessKeyId: required('R2D1_IT_R2_ACCESS_KEY_ID'),
      secretAccessKey: required('R2D1_IT_R2_SECRET_ACCESS_KEY'),
    });
    const indexes = new NodeD1IndexStore({
      accountId: required('R2D1_IT_D1_ACCOUNT_ID'),
      databaseId: required('R2D1_IT_D1_DATABASE_ID'),
      apiToken: required('R2D1_IT_D1_API_TOKEN'),
    });
    const collectionName = 'r2d1_ts_it_' + randomUUID().replaceAll('-', '');
    const schema = defineSchema({
      collection: collectionName,
      id: 'id',
      indexes: { country: 'string' },
    });
    const codec = jsonCodec((value) => {
      assert.equal(typeof value?.id, 'string');
      assert.equal(typeof value?.country, 'string');
      return value;
    });
    const users = await new R2D1(documents, indexes).collection(schema, codec);
    try {
      await users.put({ id: 'a/b', country: 'NZ' });
      assert.deepEqual(await users.get('a/b'), { id: 'a/b', country: 'NZ' });
      assert.equal(
        (await users.query().where('country').eq('NZ').limit(1).fetch()).items.length,
        1,
      );
      await users.rebuildIndex();
      await users.delete('a/b');
      assert.equal(await users.get('a/b'), undefined);
    } finally {
      try {
        await documents.delete({ collection: collectionName, id: 'a/b' });
        await indexes.clear(collectionName);
      } finally {
        documents.close();
      }
      console.log(`Live test schema retained for manual removal: ${collectionName}`);
    }
  },
);
