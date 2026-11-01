import { DocumentNotFoundError, StorageOperationError } from '../core/errors.js';
import { positive, StoredDocument, text } from '../core/model.js';
import type { DocumentKey, DocumentPage, DocumentStore } from '../core/model.js';
import { D1IndexStore, sqlRows } from '../storage/d1.js';
import type { D1Transport, SqlResult, SqlStatement } from '../storage/d1.js';
import { collectionPrefix, documentKeyFromObject, objectKey } from '../storage/r2-key.js';

/** Structural binding contracts accept Cloudflare's generated runtime types. */
export interface R2BucketBinding {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}
export interface D1DatabaseBinding {
  prepare(sql: string): {
    bind(...values: (string | number)[]): {
      all(): Promise<{ success: boolean; results?: unknown }>;
    };
    all(): Promise<{ success: boolean; results?: unknown }>;
  };
}
export class WorkersR2DocumentStore implements DocumentStore {
  constructor(private readonly bucket: R2BucketBinding) {}
  async put(documentKey: DocumentKey, document: StoredDocument): Promise<void> {
    const location = objectKey(documentKey);
    const bytes = document.content();
    try {
      await this.bucket.put(location, bytes);
    } catch {
      throw new StorageOperationError('R2 put failed');
    }
  }
  async get(documentKey: DocumentKey): Promise<StoredDocument> {
    const location = objectKey(documentKey);
    let result: { arrayBuffer(): Promise<ArrayBuffer> } | null;
    try {
      result = await this.bucket.get(location);
    } catch {
      throw new StorageOperationError('R2 get failed');
    }
    if (result === null) throw new DocumentNotFoundError(documentKey);
    try {
      return new StoredDocument(new Uint8Array(await result.arrayBuffer()));
    } catch {
      throw new StorageOperationError('R2 body read failed');
    }
  }
  async delete(documentKey: DocumentKey): Promise<void> {
    const location = objectKey(documentKey);
    try {
      await this.bucket.delete(location);
    } catch {
      throw new StorageOperationError('R2 delete failed');
    }
  }
  async list(collection: string, cursor: string | undefined, limit: number): Promise<DocumentPage> {
    const options = {
      prefix: collectionPrefix(collection),
      limit: positive(limit, 'limit'),
      ...(cursor !== undefined ? { cursor: text(cursor, 'cursor') } : {}),
    };
    try {
      const result = await this.bucket.list(options);
      if (result.objects.length > limit || typeof result.truncated !== 'boolean')
        throw new TypeError();
      if (result.truncated && !result.cursor) throw new TypeError();
      return {
        documentKeys: result.objects.map((item) => documentKeyFromObject(collection, item.key)),
        ...(result.truncated ? { nextCursor: result.cursor! } : {}),
      };
    } catch {
      throw new StorageOperationError('R2 list failed or returned an invalid page');
    }
  }
}
class BindingD1Transport implements D1Transport {
  constructor(private readonly database: D1DatabaseBinding) {}
  async execute(statement: SqlStatement): Promise<SqlResult> {
    let result: { success: boolean; results?: unknown };
    try {
      const prepared = this.database.prepare(statement.sql);
      result = await (
        statement.params.length ? prepared.bind(...statement.params) : prepared
      ).all();
    } catch {
      throw new StorageOperationError('D1 binding operation failed');
    }
    if (!result || result.success !== true)
      throw new StorageOperationError('D1 binding reported failure');
    return sqlRows(result.results ?? []);
  }
}
export class WorkersD1IndexStore extends D1IndexStore {
  constructor(database: D1DatabaseBinding) {
    super(new BindingD1Transport(database));
  }
}
