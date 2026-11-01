import type { R2Bucket, D1Database } from '@cloudflare/workers-types';
import { R2D1 } from '@nexcraft-dev/r2d1';
import { WorkersR2DocumentStore, WorkersD1IndexStore } from '@nexcraft-dev/r2d1/workers';
import { schema, codec } from './common.js';

interface Env {
  DOCUMENTS: R2Bucket;
  INDEXES: D1Database;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const users = await new R2D1(
      new WorkersR2DocumentStore(env.DOCUMENTS),
      new WorkersD1IndexStore(env.INDEXES),
    ).collection(schema, codec);
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return new Response('Supply ?id=<document-id>', { status: 400 });
    const user = await users.get(id);
    if (!user) return new Response('Not found', { status: 404 });
    return Response.json({ ...user, rank: user.rank.toString() });
  },
};
