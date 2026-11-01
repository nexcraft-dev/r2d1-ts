import { R2D1 } from '@nexcraft-dev/r2d1';
import { NodeR2DocumentStore, NodeD1IndexStore } from '@nexcraft-dev/r2d1/node';
import type { NodeR2Options, NodeD1Options } from '@nexcraft-dev/r2d1/node';
import { schema, codec } from './common.js';

/** Call with a dedicated example bucket and database. This function writes one document. */
export async function runNodeExample(r2: NodeR2Options, d1: NodeD1Options): Promise<void> {
  const documents = new NodeR2DocumentStore(r2);
  try {
    const users = await new R2D1(documents, new NodeD1IndexStore(d1)).collection(schema, codec);
    await users.put({ id: 'example-user', country: 'NZ', rank: 42n, payload: 'Example' });
    console.log(await users.get('example-user'));
    const page = await users
      .query()
      .where('country')
      .eq('NZ')
      .sortBy('rank', 'DESC')
      .limit(20)
      .fetch();
    console.log(page.items);
    if (page.nextCursor)
      console.log(
        await users
          .query()
          .where('country')
          .eq('NZ')
          .sortBy('rank', 'DESC')
          .limit(20)
          .after(page.nextCursor)
          .fetch(),
      );
    await users.delete('example-user');
  } finally {
    documents.close();
  }
}
