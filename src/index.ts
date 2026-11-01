export { R2D1, R2D1Collection } from './core/collection.js';
export type { CollectionOptions } from './core/collection.js';
export { CollectionSchema, defineSchema } from './core/schema.js';
export type { SchemaOptions, IndexedFields } from './core/schema.js';
export { Query } from './core/query.js';
export type { Comparison } from './core/query.js';
export { jsonCodec } from './core/codec.js';
export type { DocumentCodec } from './core/codec.js';
export { StoredDocument } from './core/model.js';
export type {
  DocumentKey,
  DocumentStore,
  DocumentPage,
  CollectionMetadata,
  IndexStore,
  IndexValue,
  IndexType,
  IndexEntry,
  IndexCursor,
  IndexPage,
  IndexQuery,
  Filter,
  Sort,
  SortDirection,
  ComparisonOperator,
  Page,
} from './core/model.js';
export * from './core/errors.js';
export { encodeCursor, decodeCursor } from './core/cursor.js';
