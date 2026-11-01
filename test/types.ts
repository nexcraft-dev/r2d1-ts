import { defineSchema, R2D1, StoredDocument } from '@nexcraft-dev/r2d1';
import type { DocumentCodec, DocumentStore, IndexStore } from '@nexcraft-dev/r2d1';
interface User {
  id: string;
  rank: bigint;
  country: string;
  active: boolean;
  score: number;
}
const schema = defineSchema<User>({
  collection: 'users',
  id: 'id',
  indexes: { rank: 'long', country: 'string', active: 'boolean', score: 'double' },
});
// @ts-expect-error Numeric fields cannot use the Java Long mapping.
defineSchema<User>({ collection: 'users', id: 'id', indexes: { score: 'long' } });
// @ts-expect-error IDs must select a string field.
defineSchema<User>({ collection: 'users', id: 'rank', indexes: {} });
export async function check(
  documents: DocumentStore,
  indexes: IndexStore,
  codec: DocumentCodec<User>,
): Promise<void> {
  const collection = await new R2D1(documents, indexes).collection(schema, codec);
  collection.query().where('rank').eq(1n);
  // @ts-expect-error Long filters reject number values.
  collection.query().where('rank').eq(1);
  // @ts-expect-error Unknown domain fields are rejected.
  collection.query().where('missing');
  // @ts-expect-error Unsupported sort directions are rejected.
  collection.query().sortBy('rank', 'ascending');
  const serialized: StoredDocument = codec.serialize({
    id: 'a',
    rank: 1n,
    country: 'NZ',
    active: true,
    score: 1,
  });
  codec.deserialize(serialized);
}
