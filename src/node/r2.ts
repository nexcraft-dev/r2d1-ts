import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  DocumentNotFoundError,
  StorageAccessError,
  StorageOperationError,
  StorageUnavailableError,
} from '../core/errors.js';
import { positive, StoredDocument, text } from '../core/model.js';
import type { DocumentKey, DocumentPage, DocumentStore } from '../core/model.js';
import { collectionPrefix, documentKeyFromObject, objectKey } from '../storage/r2-key.js';

export type NodeR2Options = { readonly bucket: string } & (
  | { readonly client: S3Client }
  | {
      readonly endpoint: string;
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
      readonly region?: string;
    }
);
function status(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  return (cause as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}
function missing(cause: unknown): boolean {
  return status(cause) === 404 || (cause instanceof Error && cause.name === 'NoSuchKey');
}
function failure(cause: unknown): Error {
  const code = status(cause);
  if (code === 401 || code === 403) return new StorageAccessError('R2 access denied');
  if (code === 429 || (code !== undefined && code >= 500))
    return new StorageUnavailableError('R2 is unavailable');
  return new StorageOperationError('R2 operation failed');
}
export class NodeR2DocumentStore implements DocumentStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #ownsClient: boolean;
  #closed = false;
  constructor(options: NodeR2Options) {
    this.#bucket = text(options.bucket, 'bucket');
    this.#ownsClient = !('client' in options);
    if ('client' in options) this.#client = options.client;
    else {
      const endpoint = new URL(options.endpoint);
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new TypeError(
          'R2 endpoint must be an HTTPS URL without credentials, query or fragment',
        );
      this.#client = new S3Client({
        endpoint: endpoint.href,
        region: options.region ?? 'auto',
        forcePathStyle: true,
        credentials: {
          accessKeyId: text(options.accessKeyId, 'accessKeyId'),
          secretAccessKey: text(options.secretAccessKey, 'secretAccessKey'),
        },
        maxAttempts: 1,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
    }
  }
  async put(documentKey: DocumentKey, document: StoredDocument): Promise<void> {
    const input = { Bucket: this.#bucket, Key: objectKey(documentKey), Body: document.content() };
    try {
      await this.#client.send(new PutObjectCommand(input));
    } catch (cause) {
      throw failure(cause);
    }
  }
  async get(documentKey: DocumentKey): Promise<StoredDocument> {
    const input = { Bucket: this.#bucket, Key: objectKey(documentKey) };
    try {
      const result = await this.#client.send(new GetObjectCommand(input));
      if (!result.Body) throw new StorageOperationError('R2 get returned no body');
      return new StoredDocument(await result.Body.transformToByteArray());
    } catch (cause) {
      if (missing(cause)) throw new DocumentNotFoundError(documentKey);
      throw failure(cause);
    }
  }
  async delete(documentKey: DocumentKey): Promise<void> {
    const input = { Bucket: this.#bucket, Key: objectKey(documentKey) };
    try {
      await this.#client.send(new DeleteObjectCommand(input));
    } catch (cause) {
      if (!missing(cause)) throw failure(cause);
    }
  }
  async list(collection: string, cursor: string | undefined, limit: number): Promise<DocumentPage> {
    const input = {
      Bucket: this.#bucket,
      Prefix: collectionPrefix(collection),
      MaxKeys: positive(limit, 'limit'),
      ...(cursor !== undefined ? { ContinuationToken: text(cursor, 'cursor') } : {}),
    };
    try {
      const result = await this.#client.send(new ListObjectsV2Command(input));
      const documentKeys = (result.Contents ?? []).map((item) =>
        documentKeyFromObject(collection, item.Key ?? ''),
      );
      if (documentKeys.length > limit)
        throw new StorageOperationError('R2 listing exceeded page limit');
      const nextCursor = result.NextContinuationToken;
      if (result.IsTruncated && !nextCursor)
        throw new StorageOperationError('R2 listing is truncated without a cursor');
      return { documentKeys, ...(nextCursor ? { nextCursor } : {}) };
    } catch (cause) {
      throw failure(cause);
    }
  }
  /** Destroys only an internally created client. Borrowed clients stay open. */
  close(): void {
    if (this.#ownsClient && !this.#closed) {
      this.#closed = true;
      this.#client.destroy();
    }
  }
}
