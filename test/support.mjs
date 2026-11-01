import { DatabaseSync } from 'node:sqlite';
import { DocumentNotFoundError, StoredDocument, defineSchema } from '../dist/index.js';
import { D1IndexStore } from '../dist/storage/d1.js';

export const schema = defineSchema({
  collection: 'users',
  id: 'id',
  indexes: { country: 'string', rank: 'long', score: 'double', active: 'boolean' },
});
export const user = (id = 'a', rank = 7n) => ({
  id,
  country: 'NZ',
  rank,
  score: 1.25,
  active: true,
  payload: 'hello',
});
export const codec = {
  serialize(document) {
    return new StoredDocument(
      new TextEncoder().encode(
        JSON.stringify(document, (_, value) =>
          typeof value === 'bigint' ? { $long: value.toString() } : value,
        ),
      ),
    );
  },
  deserialize(document) {
    return JSON.parse(new TextDecoder().decode(document.content()), (_, value) =>
      value && typeof value === 'object' && '$long' in value ? BigInt(value.$long) : value,
    );
  },
};
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
export class MemoryDocuments {
  data = new Map();
  events = [];
  async put(key, document) {
    this.events.push('put');
    this.data.set(`${key.collection}/${key.id}`, new StoredDocument(document.content()));
  }
  async get(key) {
    this.events.push(`get:${key.id}`);
    const value = this.data.get(`${key.collection}/${key.id}`);
    if (!value) throw new DocumentNotFoundError(key);
    return new StoredDocument(value.content());
  }
  async delete(key) {
    this.events.push('delete');
    this.data.delete(`${key.collection}/${key.id}`);
  }
  async list(collection, cursor, limit) {
    this.events.push('list');
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(collection + '/'))
      .sort()
      .map((k) => ({ collection, id: k.slice(collection.length + 1) }));
    const offset = Number(cursor ?? 0);
    return {
      documentKeys: keys.slice(offset, offset + limit),
      ...(keys.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }
}
export function sqlite() {
  const db = new DatabaseSync(':memory:');
  const statements = [];
  const transport = {
    async execute(statement) {
      statements.push(statement);
      return { rows: db.prepare(statement.sql).all(...statement.params) };
    },
  };
  return { db, statements, transport, indexes: new D1IndexStore(transport) };
}
