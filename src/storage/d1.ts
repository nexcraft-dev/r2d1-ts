import { StorageOperationError } from '../core/errors.js';
import { indexValue, key, positive } from '../core/model.js';
import type {
  CollectionMetadata,
  DocumentKey,
  IndexEntry,
  IndexQuery,
  IndexStore,
  IndexValue,
  IndexPage,
  IndexType,
} from '../core/model.js';
import { identifier, validateMetadata } from '../core/schema.js';

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}
export interface SqlResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}
export interface D1Transport {
  execute(statement: SqlStatement): Promise<SqlResult>;
}
const quote = (name: string): string => `"${identifier(name)}"`;
const sqlTypes: Record<IndexType, string> = {
  string: 'TEXT',
  long: 'INTEGER',
  double: 'REAL',
  boolean: 'INTEGER',
};
const defaults: Record<IndexType, string> = {
  string: "''",
  long: '0',
  double: '0.0',
  boolean: '0',
};
function fieldType(metadata: CollectionMetadata, name: string): IndexType {
  const field = metadata.fields.find((f) => f.name === name);
  if (!field) throw new TypeError(`field is not indexed: ${name}`);
  return field.type;
}
function compatible(type: IndexType, value: IndexValue): IndexValue {
  if (!value || value.type !== type) throw new TypeError(`index value type does not match ${type}`);
  return indexValue(type, value.value);
}
function parameter(params: (string | number)[], value: IndexValue): string {
  if (value.type === 'timestamp') throw new TypeError('D1 does not support timestamp indexes');
  params.push(
    value.type === 'long'
      ? value.value.toString()
      : value.type === 'boolean'
        ? Number(value.value)
        : value.value,
  );
  const placeholder = `?${params.length}`;
  return value.type === 'long' ? `CAST(${placeholder} AS INTEGER)` : placeholder;
}
function sameCollection(metadata: CollectionMetadata, collection: string): void {
  if (metadata.collection !== collection)
    throw new TypeError('collection does not match initialized metadata');
}
export function compileUpsert(metadata: CollectionMetadata, entry: IndexEntry): SqlStatement {
  sameCollection(metadata, entry.documentKey.collection);
  key(entry.documentKey.collection, entry.documentKey.id);
  for (const field of Object.keys(entry.values)) fieldType(metadata, field);
  const params: (string | number)[] = [entry.documentKey.id];
  const columns = ['"document_id"', ...metadata.fields.map((f) => quote(f.name))];
  const placeholders = [
    '?1',
    ...metadata.fields.map((f) => parameter(params, compatible(f.type, entry.values[f.name]!))),
  ];
  const conflict = metadata.fields.length
    ? 'DO UPDATE SET ' +
      metadata.fields.map((f) => `${quote(f.name)} = excluded.${quote(f.name)}`).join(', ')
    : 'DO NOTHING';
  return {
    sql: `INSERT INTO ${quote(metadata.collection)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT("document_id") ${conflict}`,
    params,
  };
}
export function compileQuery(metadata: CollectionMetadata, query: IndexQuery): SqlStatement {
  sameCollection(metadata, query.collection);
  positive(query.limit, 'limit');
  const params: (string | number)[] = [];
  const conditions = query.filters.map((filter) => {
    const type = fieldType(metadata, filter.field);
    if (!['=', '<>', '>', '>=', '<', '<='].includes(filter.operator))
      throw new TypeError('unsupported comparison');
    if (type === 'boolean' && filter.operator !== '=' && filter.operator !== '<>')
      throw new TypeError('boolean supports only equality comparisons');
    return `${quote(filter.field)} ${filter.operator} ${parameter(params, compatible(type, filter.value))}`;
  });
  const sort = query.sort;
  let sortType: IndexType | undefined;
  if (sort) {
    sortType = fieldType(metadata, sort.field);
    if (sort.direction !== 'ASC' && sort.direction !== 'DESC')
      throw new TypeError('invalid sort direction');
  }
  const direction = sort?.direction ?? 'ASC';
  if (query.cursor) {
    const cursor = query.cursor;
    sameCollection(metadata, cursor.lastDocumentKey.collection);
    key(cursor.lastDocumentKey.collection, cursor.lastDocumentKey.id);
    if (!sort) {
      if (cursor.sortValue !== undefined)
        throw new TypeError('unsorted cursor must not include sort value');
      conditions.push(
        `"document_id" > ${parameter(params, { type: 'string', value: cursor.lastDocumentKey.id })}`,
      );
    } else {
      const value = parameter(params, compatible(sortType!, cursor.sortValue!));
      const id = parameter(params, { type: 'string', value: cursor.lastDocumentKey.id });
      const op = direction === 'ASC' ? '>' : '<';
      conditions.push(
        `(${quote(sort.field)} ${op} ${value} OR (${quote(sort.field)} = ${value} AND "document_id" ${op} ${id}))`,
      );
    }
  }
  const projection = sort
    ? ', ' +
      (sortType === 'long'
        ? `CAST(${quote(sort.field)} AS TEXT) AS ${quote(sort.field)}`
        : quote(sort.field))
    : '';
  const order = sort
    ? `${quote(metadata.collection)}.${quote(sort.field)} ${direction}, "document_id" ${direction}`
    : '"document_id" ASC';
  params.push(query.limit + 1);
  return {
    sql: `SELECT "document_id"${projection} FROM ${quote(metadata.collection)}${conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY ${order} LIMIT ?${params.length}`,
    params,
  };
}
function readValue(type: IndexType, value: unknown): IndexValue {
  try {
    if (type === 'long') {
      if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new TypeError();
      return indexValue(type, BigInt(value));
    }
    if (type === 'boolean') {
      if (value !== 0 && value !== 1) throw new TypeError();
      return indexValue(type, value === 1);
    }
    return indexValue(type, value);
  } catch {
    throw new StorageOperationError('D1 returned an invalid indexed value');
  }
}
export function queryPage(
  metadata: CollectionMetadata,
  query: IndexQuery,
  result: SqlResult,
): IndexPage {
  const rows = result.rows.slice(0, query.limit);
  const keys = rows.map((row) => {
    try {
      return key(metadata.collection, row['document_id'] as string);
    } catch {
      throw new StorageOperationError('D1 returned an invalid document_id');
    }
  });
  // Validate each returned sort value, including final pages.
  const sortValues = query.sort
    ? rows.map((row) => readValue(fieldType(metadata, query.sort!.field), row[query.sort!.field]))
    : [];
  const hasMore = result.rows.length > query.limit && keys.length > 0;
  return {
    documentKeys: keys,
    ...(hasMore
      ? {
          nextCursor: {
            lastDocumentKey: keys.at(-1)!,
            ...(query.sort ? { sortValue: sortValues.at(-1)! } : {}),
          },
        }
      : {}),
  };
}
function stringCell(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== 'string')
    throw new StorageOperationError(`D1 schema returned invalid ${name}`);
  return value;
}
function integerCell(row: Readonly<Record<string, unknown>>, name: string): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new StorageOperationError(`D1 schema returned invalid ${name}`);
  return value;
}
async function initializeSchema(
  transport: D1Transport,
  metadata: CollectionMetadata,
): Promise<void> {
  const table = quote(metadata.collection);
  const execute = (sql: string): Promise<SqlResult> => transport.execute({ sql, params: [] });
  const inspect = async (): Promise<Map<string, Readonly<Record<string, unknown>>>> => {
    const result = await execute(`PRAGMA table_info(${table})`);
    const columns = new Map<string, Readonly<Record<string, unknown>>>();
    for (const row of result.rows) {
      const name = stringCell(row, 'name');
      if (columns.has(name)) throw new StorageOperationError('D1 returned duplicate columns');
      columns.set(name, row);
    }
    return columns;
  };
  const validate = (
    columns: Map<string, Readonly<Record<string, unknown>>>,
    requireAll: boolean,
  ): void => {
    const id = columns.get('document_id');
    if (
      !id ||
      stringCell(id, 'type').toUpperCase() !== 'TEXT' ||
      integerCell(id, 'notnull') !== 1 ||
      integerCell(id, 'pk') <= 0
    )
      throw new StorageOperationError('D1 schema has incompatible document_id');
    for (const field of metadata.fields) {
      const actual = columns.get(field.name);
      if (!actual && !requireAll) continue;
      if (
        !actual ||
        stringCell(actual, 'type').toUpperCase() !== sqlTypes[field.type] ||
        integerCell(actual, 'notnull') !== 1 ||
        integerCell(actual, 'pk') !== 0
      )
        throw new StorageOperationError(`D1 schema has incompatible column: ${field.name}`);
    }
  };
  let columns = await inspect();
  if (columns.size === 0) {
    const definitions = [
      '"document_id" TEXT PRIMARY KEY NOT NULL',
      ...metadata.fields.map((f) => `${quote(f.name)} ${sqlTypes[f.type]} NOT NULL`),
    ];
    await execute(`CREATE TABLE IF NOT EXISTS ${table} (${definitions.join(', ')})`);
    columns = await inspect();
    validate(columns, true);
  } else {
    validate(columns, false);
    const missing = metadata.fields.filter((f) => !columns.has(f.name));
    if (missing.length) {
      const result = await execute(`SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS "has_rows"`);
      if (result.rows.length !== 1)
        throw new StorageOperationError('D1 row-existence query returned invalid result');
      const exists = integerCell(result.rows[0]!, 'has_rows');
      if (exists !== 0 && exists !== 1)
        throw new StorageOperationError('D1 row-existence query returned invalid value');
      if (exists)
        throw new StorageOperationError(
          'D1 schema requires a rebuild before adding required indexed fields',
        );
      for (const field of missing)
        await execute(
          `ALTER TABLE ${table} ADD COLUMN ${quote(field.name)} ${sqlTypes[field.type]} NOT NULL DEFAULT ${defaults[field.type]}`,
        );
      validate(await inspect(), true);
    }
  }
  for (const field of metadata.fields) {
    const name = `idx_${metadata.collection}_${field.name}`;
    const inspectNames = async (): Promise<string[]> =>
      (await execute(`PRAGMA index_list(${table})`)).rows.map((r) => stringCell(r, 'name'));
    if (!(await inspectNames()).includes(name))
      await execute(`CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${table} (${quote(field.name)})`);
    if (!(await inspectNames()).includes(name))
      throw new StorageOperationError('D1 index name is unavailable');
    const info = await execute(`PRAGMA index_info(${quote(name)})`);
    if (info.rows.length !== 1 || stringCell(info.rows[0]!, 'name') !== field.name)
      throw new StorageOperationError('D1 index is incompatible with indexed field');
  }
}

/** Shared D1 engine. Transports supply only prepared SQL execution. */
export class D1IndexStore implements IndexStore {
  readonly #registrations = new Map<
    string,
    { metadata: CollectionMetadata; ready: Promise<void> }
  >();
  constructor(private readonly transport: D1Transport) {}
  async initialize(input: CollectionMetadata): Promise<void> {
    const metadata = validateMetadata(input);
    const existing = this.#registrations.get(metadata.collection);
    if (existing) {
      if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata))
        throw new TypeError('collection is already initialized with different metadata');
      return existing.ready;
    }
    const ready = Promise.resolve().then(() => initializeSchema(this.transport, metadata));
    this.#registrations.set(metadata.collection, { metadata, ready });
    return ready;
  }
  async upsert(entry: IndexEntry): Promise<void> {
    const registration = this.registration(entry.documentKey.collection);
    const statement = compileUpsert(registration.metadata, entry);
    await registration.ready;
    await this.transport.execute(statement);
  }
  async query(query: IndexQuery): Promise<IndexPage> {
    const registration = this.registration(query.collection);
    const statement = compileQuery(registration.metadata, query);
    await registration.ready;
    return queryPage(registration.metadata, query, await this.transport.execute(statement));
  }
  async delete(documentKey: DocumentKey): Promise<void> {
    key(documentKey.collection, documentKey.id);
    const registration = this.registration(documentKey.collection);
    await registration.ready;
    await this.transport.execute({
      sql: `DELETE FROM ${quote(documentKey.collection)} WHERE "document_id" = ?1`,
      params: [documentKey.id],
    });
  }
  async clear(collection: string): Promise<void> {
    const registration = this.registration(collection);
    await registration.ready;
    await this.transport.execute({ sql: `DELETE FROM ${quote(collection)}`, params: [] });
  }
  private registration(collection: string): { metadata: CollectionMetadata; ready: Promise<void> } {
    const registration = this.#registrations.get(collection);
    if (!registration) throw new StorageOperationError('D1 collection is not initialized');
    return registration;
  }
}

/** Validate transport rows without accepting arrays, nulls, or primitive values. */
export function sqlRows(value: unknown): SqlResult {
  if (
    !Array.isArray(value) ||
    value.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))
  )
    throw new StorageOperationError('D1 returned invalid rows');
  return { rows: value as Record<string, unknown>[] };
}
