export interface DocumentKey {
  readonly collection: string;
  readonly id: string;
}
export type IndexType = 'string' | 'long' | 'double' | 'boolean';
export type IndexValue =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'long'; readonly value: bigint }
  | { readonly type: 'double'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'timestamp'; readonly seconds: bigint; readonly nanos: number };
export interface IndexCursor {
  readonly lastDocumentKey: DocumentKey;
  readonly sortValue?: IndexValue;
}
export interface IndexEntry {
  readonly documentKey: DocumentKey;
  readonly values: Readonly<Record<string, IndexValue>>;
}
export type ComparisonOperator = '=' | '<>' | '>' | '>=' | '<' | '<=';
export type SortDirection = 'ASC' | 'DESC';
export interface Filter {
  readonly field: string;
  readonly operator: ComparisonOperator;
  readonly value: IndexValue;
}
export interface Sort {
  readonly field: string;
  readonly direction: SortDirection;
}
export interface IndexQuery {
  readonly collection: string;
  readonly filters: readonly Filter[];
  readonly limit: number;
  readonly sort?: Sort;
  readonly cursor?: IndexCursor;
}
export interface IndexPage {
  readonly documentKeys: readonly DocumentKey[];
  readonly nextCursor?: IndexCursor;
}
export interface DocumentPage {
  readonly documentKeys: readonly DocumentKey[];
  readonly nextCursor?: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** Serialized bytes with defensive copies on input and output. */
export class StoredDocument {
  readonly #bytes: Uint8Array;
  constructor(content: Uint8Array) {
    if (!(content instanceof Uint8Array)) throw new TypeError('content must be Uint8Array');
    this.#bytes = new Uint8Array(content);
  }
  content(): Uint8Array {
    return this.#bytes.slice();
  }
}
export interface DocumentStore {
  put(key: DocumentKey, document: StoredDocument): Promise<void>;
  get(key: DocumentKey): Promise<StoredDocument>;
  delete(key: DocumentKey): Promise<void>;
  list(collection: string, cursor: string | undefined, limit: number): Promise<DocumentPage>;
}
export interface CollectionMetadata {
  readonly collection: string;
  readonly fields: readonly { readonly name: string; readonly type: IndexType }[];
}
export interface IndexStore {
  initialize(metadata: CollectionMetadata): Promise<void>;
  upsert(entry: IndexEntry): Promise<void>;
  delete(key: DocumentKey): Promise<void>;
  query(query: IndexQuery): Promise<IndexPage>;
  clear(collection: string): Promise<void>;
}

// Java String.isBlank excludes nonbreaking spaces.
export function text(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    /^[\u0009-\u000D\u001C-\u0020\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]*$/u.test(
      value,
    )
  ) {
    throw new TypeError(`${name} must be a nonblank string`);
  }
  return value;
}
export function key(collection: string, id: string): DocumentKey {
  return Object.freeze({ collection: text(collection, 'collection'), id: text(id, 'id') });
}
export function positive(value: number, name: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new RangeError(`${name} must be a positive integer <= ${max}`);
  return value;
}
export function long(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < -(1n << 63n) || value > (1n << 63n) - 1n) {
    throw new TypeError('long must be a signed 64-bit bigint');
  }
  return value;
}
export function indexValue(type: IndexType, value: unknown): IndexValue {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return Object.freeze({ type, value });
      break;
    case 'long':
      return Object.freeze({ type, value: long(value) });
    case 'double':
      if (typeof value === 'number' && Number.isFinite(value))
        return Object.freeze({ type, value });
      break;
    case 'boolean':
      if (typeof value === 'boolean') return Object.freeze({ type, value });
      break;
  }
  throw new TypeError(`index value must have type ${type}`);
}
