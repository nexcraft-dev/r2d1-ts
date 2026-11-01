import { indexValue, key } from './model.js';
import type { CollectionMetadata, IndexEntry, IndexType, IndexValue } from './model.js';

export type IndexedFields<T> = Partial<{
  readonly [K in keyof T & string]: T[K] extends string
    ? 'string'
    : T[K] extends bigint
      ? 'long'
      : T[K] extends number
        ? 'double'
        : T[K] extends boolean
          ? 'boolean'
          : never;
}>;
export interface SchemaOptions<T extends object> {
  readonly collection: string;
  readonly id: { [K in keyof T & string]: T[K] extends string ? K : never }[keyof T & string];
  readonly indexes: IndexedFields<T>;
}
export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new TypeError('identifier must match [A-Za-z_][A-Za-z0-9_]*');
  return value;
}
export function validateMetadata(metadata: CollectionMetadata): CollectionMetadata {
  const collection = identifier(metadata.collection);
  if (metadata.fields.length > 5) throw new RangeError('at most five indexed fields are supported');
  const seen = new Set<string>();
  const fields = metadata.fields
    .map((field) => {
      const name = identifier(field.name);
      if (name === 'document_id' || seen.has(name))
        throw new TypeError('reserved or duplicate indexed field');
      if (!['string', 'long', 'double', 'boolean'].includes(field.type))
        throw new TypeError('unsupported index type');
      seen.add(name);
      return Object.freeze({ name, type: field.type });
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze({ collection, fields: Object.freeze(fields) });
}
export class CollectionSchema<T extends object> {
  readonly metadata: CollectionMetadata;
  readonly id: keyof T & string;
  constructor(options: SchemaOptions<T>) {
    identifier(options.id);
    this.id = options.id;
    this.metadata = validateMetadata({
      collection: options.collection,
      fields: Object.entries(options.indexes).map(([name, type]) => ({
        name,
        type: type as IndexType,
      })),
    });
    Object.freeze(this);
  }
  value(field: string, value: unknown): IndexValue {
    const definition = this.metadata.fields.find((f) => f.name === field);
    if (!definition) throw new TypeError(`field is not indexed: ${field}`);
    return indexValue(definition.type, value);
  }
  entry(document: T): IndexEntry {
    if (document === null || typeof document !== 'object')
      throw new TypeError('document must be an object');
    const values = Object.create(null) as Record<string, IndexValue>;
    for (const field of this.metadata.fields)
      values[field.name] = this.value(field.name, document[field.name as keyof T]);
    return Object.freeze({
      documentKey: key(this.metadata.collection, document[this.id] as string),
      values: Object.freeze(values),
    });
  }
}
export function defineSchema<T extends object>(options: SchemaOptions<T>): CollectionSchema<T> {
  return new CollectionSchema(options);
}
