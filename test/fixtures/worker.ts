import { R2D1, defineSchema, StoredDocument } from '../../src/index.js';
import type { DocumentCodec } from '../../src/index.js';
import { WorkersR2DocumentStore, WorkersD1IndexStore } from '../../src/workers/index.js';
import type { R2BucketBinding, D1DatabaseBinding } from '../../src/workers/index.js';

interface User {
  id: string;
  rank: bigint;
  country: string;
}
const schema = defineSchema<User>({
  collection: 'users',
  id: 'id',
  indexes: { rank: 'long', country: 'string' },
});
const codec: DocumentCodec<User> = {
  serialize(value) {
    return new StoredDocument(
      new TextEncoder().encode(JSON.stringify({ ...value, rank: value.rank.toString() })),
    );
  },
  deserialize(document) {
    const value = JSON.parse(new TextDecoder().decode(document.content())) as {
      id: string;
      rank: string;
      country: string;
    };
    return { ...value, rank: BigInt(value.rank) };
  },
};
export default {
  async fetch(
    request: Request,
    env: { BUCKET: R2BucketBinding; DB: D1DatabaseBinding },
  ): Promise<Response> {
    const url = new URL(request.url);
    const collection = await new R2D1(
      new WorkersR2DocumentStore(env.BUCKET),
      new WorkersD1IndexStore(env.DB),
    ).collection(schema, codec);
    try {
      let result: unknown;
      switch (url.pathname) {
        case '/put': {
          const value = (await request.json()) as { id: string; rank: string; country: string };
          await collection.put({ ...value, rank: BigInt(value.rank) });
          result = { ok: true };
          break;
        }
        case '/get':
          result = await collection.get(url.searchParams.get('id')!);
          break;
        case '/delete':
          await collection.delete(url.searchParams.get('id')!);
          result = { ok: true };
          break;
        case '/rebuild':
          await collection.rebuildIndex();
          result = { ok: true };
          break;
        default: {
          let query = collection
            .query()
            .sortBy('rank', (url.searchParams.get('direction') ?? 'ASC') as 'ASC' | 'DESC')
            .limit(1);
          const cursor = url.searchParams.get('cursor');
          if (cursor) query = query.after(cursor);
          result = await query.fetch();
        }
      }
      return new Response(
        JSON.stringify(result ?? null, (_, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    } catch (error) {
      return Response.json(
        { name: (error as Error).name, message: (error as Error).message },
        { status: 500 },
      );
    }
  },
};
