import { decodeCursor } from './cursor.js';
import { positive, text } from './model.js';
import type { ComparisonOperator, Filter, IndexQuery, Page, Sort, SortDirection } from './model.js';
import type { CollectionSchema } from './schema.js';

interface State {
  readonly filters: readonly Filter[];
  readonly sort?: Sort;
  readonly limit?: number;
  readonly cursor?: string;
}
export class Query<T extends object> {
  readonly #state: State;
  constructor(
    readonly schema: CollectionSchema<T>,
    readonly execute: (query: IndexQuery) => Promise<Page<T>>,
    state: State = { filters: [] },
  ) {
    this.#state = Object.freeze({ ...state, filters: Object.freeze([...state.filters]) });
    Object.freeze(this);
  }
  where<K extends keyof T & string>(field: K): Comparison<T, T[K]> {
    text(field, 'field');
    const compare = (operator: ComparisonOperator, value: T[K]): Query<T> => {
      const indexed = this.schema.value(field, value);
      if (indexed.type === 'boolean' && operator !== '=' && operator !== '<>')
        throw new TypeError('boolean supports only equality comparisons');
      const filter = Object.freeze({ field, operator, value: indexed });
      return this.copy({ filters: [...this.#state.filters, filter] });
    };
    return Object.freeze({
      eq: (v: T[K]) => compare('=', v),
      notEq: (v: T[K]) => compare('<>', v),
      gt: (v: T[K]) => compare('>', v),
      gte: (v: T[K]) => compare('>=', v),
      lt: (v: T[K]) => compare('<', v),
      lte: (v: T[K]) => compare('<=', v),
    });
  }
  sortBy(field: keyof T & string, direction: SortDirection = 'ASC'): Query<T> {
    if (this.#state.sort) throw new TypeError('sort is already configured');
    if (!this.schema.metadata.fields.some((f) => f.name === field))
      throw new TypeError(`field is not indexed: ${field}`);
    if (direction !== 'ASC' && direction !== 'DESC') throw new TypeError('invalid sort direction');
    return this.copy({ sort: Object.freeze({ field, direction }) });
  }
  limit(limit: number): Query<T> {
    if (this.#state.limit !== undefined) throw new TypeError('limit is already configured');
    return this.copy({ limit: positive(limit, 'limit') });
  }
  after(cursor: string): Query<T> {
    if (this.#state.cursor !== undefined) throw new TypeError('cursor is already configured');
    return this.copy({ cursor: text(cursor, 'cursor') });
  }
  async fetch(): Promise<Page<T>> {
    if (this.#state.limit === undefined)
      throw new TypeError('limit must be configured before fetch');
    return this.execute({
      collection: this.schema.metadata.collection,
      filters: this.#state.filters,
      limit: this.#state.limit,
      ...(this.#state.sort ? { sort: this.#state.sort } : {}),
      ...(this.#state.cursor ? { cursor: decodeCursor(this.#state.cursor) } : {}),
    });
  }
  private copy(update: Partial<State>): Query<T> {
    return new Query(this.schema, this.execute, { ...this.#state, ...update });
  }
}
export interface Comparison<T extends object, V> {
  eq(value: V): Query<T>;
  notEq(value: V): Query<T>;
  gt(value: V): Query<T>;
  gte(value: V): Query<T>;
  lt(value: V): Query<T>;
  lte(value: V): Query<T>;
}
