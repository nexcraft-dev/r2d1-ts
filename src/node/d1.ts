import {
  StorageAccessError,
  StorageOperationError,
  StorageUnavailableError,
} from '../core/errors.js';
import { text } from '../core/model.js';
import { D1IndexStore, sqlRows } from '../storage/d1.js';
import type { D1Transport, SqlResult, SqlStatement } from '../storage/d1.js';

export interface NodeD1Options {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}
/** Release the connection. The HTTP status already decides the error, so a cancel failure is not reported. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The caller throws a status-based error. The unread body must not replace it.
  }
}
class RestD1Transport implements D1Transport {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: NodeD1Options) {
    this.#endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(text(options.accountId, 'accountId'))}/d1/database/${encodeURIComponent(text(options.databaseId, 'databaseId'))}/query`;
    this.#token = text(options.apiToken, 'apiToken');
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async execute(statement: SqlStatement): Promise<SqlResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: statement.sql, params: statement.params }),
      });
    } catch {
      throw new StorageUnavailableError('D1 request failed before receiving a response');
    }
    if (response.status === 401 || response.status === 403) {
      await discard(response);
      throw new StorageAccessError(`D1 access denied with HTTP status ${response.status}`);
    }
    if (response.status === 429 || response.status >= 500) {
      await discard(response);
      throw new StorageUnavailableError(`D1 unavailable with HTTP status ${response.status}`);
    }
    if (!response.ok) {
      await discard(response);
      throw new StorageOperationError(`D1 request failed with HTTP status ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new StorageOperationError('D1 response could not be decoded');
    }
    if (!payload || typeof payload !== 'object')
      throw new StorageOperationError('D1 returned an invalid response');
    const envelope = payload as Record<string, unknown>;
    if (
      envelope['success'] !== true ||
      !Array.isArray(envelope['result']) ||
      envelope['result'].length !== 1
    )
      throw new StorageOperationError('D1 API reported failure or invalid result count');
    const result = envelope['result'][0] as Record<string, unknown> | null;
    if (!result || result['success'] !== true)
      throw new StorageOperationError('D1 query reported failure');
    return sqlRows(result['results'] ?? []);
  }
}
export class NodeD1IndexStore extends D1IndexStore {
  constructor(options: NodeD1Options) {
    super(new RestD1Transport(options));
  }
}
