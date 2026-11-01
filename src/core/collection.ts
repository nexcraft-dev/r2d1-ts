import { encodeCursor } from './cursor.js';
import {
  AdmissionRejectedError,
  DocumentNotFoundError,
  InconsistentStateError,
  PartialFailureError,
  PersistenceError,
} from './errors.js';
import { key, positive, StoredDocument } from './model.js';
import type {
  DocumentKey,
  DocumentStore,
  IndexEntry,
  IndexQuery,
  IndexStore,
  Page,
} from './model.js';
import type { DocumentCodec } from './codec.js';
import type { CollectionSchema } from './schema.js';
import { Query } from './query.js';

export interface CollectionOptions {
  readonly hydrationConcurrency?: number;
  readonly maxConcurrentOperations?: number;
}

async function mapBounded<A, B>(
  items: readonly A[],
  concurrency: number,
  map: (value: A) => Promise<B>,
): Promise<B[]> {
  const output = new Array<B>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          output[index] = await map(items[index]!);
        } catch (cause) {
          if (!failed) {
            failed = true;
            failure = cause;
          }
        }
      }
    }),
  );
  // Drain in-flight reads before releasing the admission slot.
  if (failed) throw failure;
  return output;
}

export class R2D1Collection<T extends object> {
  readonly #concurrency: number;
  readonly #maxOperations: number;
  #active = 0;
  constructor(
    readonly schema: CollectionSchema<T>,
    private readonly documents: DocumentStore,
    private readonly indexes: IndexStore,
    private readonly codec: DocumentCodec<T>,
    options: CollectionOptions = {},
  ) {
    this.#concurrency = positive(options.hydrationConcurrency ?? 16, 'hydrationConcurrency');
    this.#maxOperations =
      options.maxConcurrentOperations === undefined
        ? Infinity
        : positive(options.maxConcurrentOperations, 'maxConcurrentOperations');
  }
  async put(document: T): Promise<void> {
    return this.run(async () => {
      const entry = this.schema.entry(document);
      const stored = this.codec.serialize(document);
      if (!(stored instanceof StoredDocument))
        throw new TypeError('codec must return StoredDocument');
      await this.documents.put(entry.documentKey, stored);
      try {
        await this.indexes.upsert(entry);
      } catch (cause) {
        throw new PartialFailureError(
          'Document write succeeded but index upsert failed',
          entry.documentKey,
          cause,
        );
      }
    });
  }
  async get(id: string): Promise<T | undefined> {
    return this.run(async () => {
      let stored: StoredDocument;
      try {
        stored = await this.documents.get(key(this.schema.metadata.collection, id));
      } catch (cause) {
        if (cause instanceof DocumentNotFoundError) return undefined;
        throw cause;
      }
      return this.deserialize(stored);
    });
  }
  async delete(id: string): Promise<void> {
    return this.run(async () => {
      const documentKey = key(this.schema.metadata.collection, id);
      await this.documents.delete(documentKey);
      try {
        await this.indexes.delete(documentKey);
      } catch (cause) {
        throw new PartialFailureError(
          'Document delete succeeded but index cleanup failed',
          documentKey,
          cause,
        );
      }
    });
  }
  query(): Query<T> {
    return new Query(this.schema, (query) => this.fetch(query));
  }
  async rebuildIndex(): Promise<void> {
    return this.run(async () => {
      const prepare = async (
        cursor?: string,
      ): Promise<{ entries: IndexEntry[]; nextCursor?: string }> => {
        const page = await this.documents.list(this.schema.metadata.collection, cursor, 100);
        if (page.documentKeys.length > 100)
          throw new PersistenceError('Document listing exceeded page limit');
        const entries = await mapBounded(
          page.documentKeys,
          this.#concurrency,
          async (documentKey) => {
            this.validateKey(documentKey);
            const entry = this.schema.entry(await this.hydrate(documentKey));
            if (entry.documentKey.id !== documentKey.id)
              throw new InconsistentStateError(
                'Document key does not match its content',
                documentKey,
              );
            return entry;
          },
        );
        return {
          entries,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        };
      };
      let page = await prepare();
      await this.indexes.clear(this.schema.metadata.collection);
      let cursor: string | undefined;
      while (true) {
        for (const entry of page.entries) await this.indexes.upsert(entry);
        if (page.nextCursor === undefined) break;
        if (!page.nextCursor || page.nextCursor === cursor)
          throw new PersistenceError('Document listing did not advance');
        cursor = page.nextCursor;
        page = await prepare(cursor);
      }
    });
  }
  private async fetch(query: IndexQuery): Promise<Page<T>> {
    return this.run(async () => {
      const page = await this.indexes.query(query);
      if (page.documentKeys.length > query.limit)
        throw new PersistenceError('Index exceeded page limit');
      const items = await mapBounded(page.documentKeys, this.#concurrency, (documentKey) => {
        this.validateKey(documentKey);
        return this.hydrate(documentKey);
      });
      if (page.nextCursor) this.validateKey(page.nextCursor.lastDocumentKey);
      return Object.freeze({
        items: Object.freeze(items),
        ...(page.nextCursor ? { nextCursor: encodeCursor(page.nextCursor) } : {}),
      });
    });
  }
  private validateKey(documentKey: DocumentKey): void {
    key(documentKey.collection, documentKey.id);
    if (documentKey.collection !== this.schema.metadata.collection)
      throw new PersistenceError('Storage returned a key outside the collection');
  }
  private async hydrate(documentKey: DocumentKey): Promise<T> {
    let stored: StoredDocument;
    try {
      stored = await this.documents.get(documentKey);
    } catch (cause) {
      if (cause instanceof DocumentNotFoundError)
        throw new InconsistentStateError(
          'Index or listing references a missing document',
          documentKey,
          cause,
        );
      throw cause;
    }
    return this.deserialize(stored);
  }
  private deserialize(stored: StoredDocument): T {
    const value = this.codec.deserialize(stored);
    if (value === null || value === undefined) throw new TypeError('codec returned no document');
    return value;
  }
  private async run<R>(operation: () => Promise<R>): Promise<R> {
    if (this.#active >= this.#maxOperations)
      throw new AdmissionRejectedError('Collection operation limit reached');
    this.#active++;
    try {
      return await operation();
    } finally {
      this.#active--;
    }
  }
}

export class R2D1 {
  constructor(
    private readonly documents: DocumentStore,
    private readonly indexes: IndexStore,
  ) {}
  async collection<T extends object>(
    schema: CollectionSchema<T>,
    codec: DocumentCodec<T>,
    options?: CollectionOptions,
  ): Promise<R2D1Collection<T>> {
    if (!schema || !codec) throw new TypeError('schema and codec are required');
    // Validate options before any schema I/O.
    const collection = new R2D1Collection(schema, this.documents, this.indexes, codec, options);
    await this.indexes.initialize(schema.metadata);
    return collection;
  }
}
