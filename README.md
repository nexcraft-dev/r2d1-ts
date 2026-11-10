# @nexcraft-dev/r2d1

An ESM TypeScript document library for Node.js 22+ and Cloudflare Workers. R2 stores authoritative document bytes. D1 stores a rebuildable index.

This port preserves Java R2D1 storage contracts at commit `5afb4f97635ff8ff533e09b715232be13318b4b9`. Install with `npm install @nexcraft-dev/r2d1`.

## Node.js

```ts
import { R2D1, defineSchema, jsonCodec } from '@nexcraft-dev/r2d1';
import { NodeR2DocumentStore, NodeD1IndexStore } from '@nexcraft-dev/r2d1/node';

interface User {
  id: string;
  country: string;
  score: number;
}
const schema = defineSchema<User>({
  collection: 'users',
  id: 'id',
  indexes: { country: 'string', score: 'double' },
});
const codec = jsonCodec<User>((value) => {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid user');
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== 'string' ||
    typeof user.country !== 'string' ||
    typeof user.score !== 'number' ||
    !Number.isFinite(user.score)
  ) {
    throw new TypeError('Invalid user');
  }
  return { id: user.id, country: user.country, score: user.score };
});
const documents = new NodeR2DocumentStore({
  endpoint: 'https://<account-id>.r2.cloudflarestorage.com',
  bucket: '<bucket>',
  accessKeyId: '<access-key-id>',
  secretAccessKey: '<secret-access-key>',
});
const indexes = new NodeD1IndexStore({
  accountId: '<account-id>',
  databaseId: '<database-id>',
  apiToken: '<api-token>',
});
const users = await new R2D1(documents, indexes).collection(schema, codec, {
  hydrationConcurrency: 16,
  maxConcurrentOperations: 32,
});
try {
  await users.put({ id: 'user-1', country: 'NZ', score: 4.5 });
  const user = await users.get('user-1'); // undefined only when absent
  const page = await users
    .query()
    .where('country')
    .eq('NZ')
    .sortBy('score', 'DESC')
    .limit(20)
    .fetch();
  if (page.nextCursor) {
    console.log(
      await users
        .query()
        .where('country')
        .eq('NZ')
        .sortBy('score', 'DESC')
        .limit(20)
        .after(page.nextCursor)
        .fetch(),
    );
  }
  console.log(user, page.items);
  await users.delete('user-1');
} finally {
  documents.close();
}
```

Supply credentials from application secret configuration. The library does not read environment variables or log credentials. R2 uses the AWS S3 SDK, region `auto` by default, and no library-configured retries. To borrow a client, supply `{ client, bucket }`. `close()` destroys only an internally created client. A borrowed client's configuration belongs to the caller. D1 uses the Cloudflare REST query endpoint.

## Cloudflare Workers

```ts
import { R2D1 } from '@nexcraft-dev/r2d1';
import { WorkersR2DocumentStore, WorkersD1IndexStore } from '@nexcraft-dev/r2d1/workers';

// Inside your Worker, using the same schema and codec:
const users = await new R2D1(
  new WorkersR2DocumentStore(env.DOCUMENTS),
  new WorkersD1IndexStore(env.INDEXES),
).collection(schema, codec);
```

Bind an R2 bucket as `DOCUMENTS` and a D1 database as `INDEXES`. The library does not provision or deploy resources. Core and the Workers adapters need no `nodejs_compat` flag. Their subpaths import no AWS SDK or Node built-ins. The npm package includes the Node dependency, but a Workers bundle includes only reachable modules.

See the [Node example](examples/node.ts), [Workers example](examples/workers.ts), and [shared codec example](examples/common.ts). Examples are TypeScript source for your build tool.

## Schema and queries

- Collection and indexed-field names must match `[A-Za-z_][A-Za-z0-9_]*`.
- IDs are nonblank strings. Values are not trimmed or normalized.
- Each collection has at most five indexed fields. `document_id` is reserved.
- Index types: `string` (TEXT), `long` (INTEGER), `double` (REAL), `boolean` (INTEGER 0/1).
- Use signed 64-bit `bigint` for `long`. A JavaScript `number` is rejected for this type.
- Indexed values must be present and non-null. Double values must be finite.
- `where(field).eq/notEq/gt/gte/lt/lte(value)` adds an AND filter. Boolean fields support only `eq` and `notEq`.
- Every indexed field can be sorted. One sort and a positive integer limit are supported. Default order is document ID ascending.
- Sorted queries use ID as a tie-breaker in the same direction. Continuation uses Java-compatible opaque v1 cursors.
- Repeat the same collection, filters and sort when continuing. Java cursors do not encode the filter or sort field. They are not signed authorization tokens.
- Builders are immutable. Repeated sort, limit or cursor configuration fails.

Core exports `DocumentStore`, `IndexStore`, `DocumentCodec<T>`, and their model types for custom integrations. SPI methods return Promises. `DocumentStore.get` rejects with `DocumentNotFoundError` when absent. Collection `get` maps only that failure to `undefined`.

## Java data compatibility

R2 keys use uppercase percent encoding of each UTF-8 collection and ID segment, separated by `/`. There is no file suffix or added envelope. D1 uses the collection name, `document_id TEXT PRIMARY KEY NOT NULL`, required typed columns, and `idx_<collection>_<field>` indexes.

**Java supplies no default document format.** Use a TypeScript codec that matches your application's Java codec. `jsonCodec` is an explicit helper. It uses ordinary JSON and cannot serialize `bigint`. Supply a custom codec for Long values or custom formats. The shared example matches the Java integration-test codec's dot-separated base64url fields and decimal Long.

Long bindings use decimal text with `CAST(... AS INTEGER)`. Sorted Long values are selected as text and converted to `bigint`. Stored columns and numeric query order remain compatible. No data rewrite is needed.

D1 initialization inspects actual schema. Same-schema initialization shares I/O. Conflicting schemas fail. Initialization failures remain failed for that store instance. Missing columns can be added to an empty table. Required additions to populated tables fail. Extra columns and indexes remain intact. Incompatible columns/index names require application-managed migration. Extra required columns without defaults can prevent insertion and are not removed automatically.

## Consistency and recovery

PUT and DELETE mutate the authoritative store first, then the index. No transaction spans both stores. An index failure after authoritative success raises `PartialFailureError`, retaining `documentKey` and `cause`. No rollback occurs. GET reflects authoritative existence.

Hydration preserves index order. Missing documents raise `InconsistentStateError` for the whole page. Stale rows are not skipped.

Pause all application writes to the collection, including other processes, before calling `await users.rebuildIndex()`. Rebuild prepares the first page before clearing rows. It scans 100 keys per page and preserves schema. First-page preparation failure leaves existing rows intact. Later failure can leave an incomplete index. Resolve the cause and rebuild again. Rebuild is not atomic and has no distributed lock.

Hydration defaults to 16 concurrent reads per operation. Optional `maxConcurrentOperations` rejects excess operations on that collection instance with `AdmissionRejectedError`. There is no queue, timer, or cross-instance cap. Caller timeouts do not guarantee cancellation of storage requests.

Storage errors use `StorageError`, `StorageAccessError`, `StorageUnavailableError`, and `StorageOperationError`. Native failures without reliable status use `StorageOperationError`. Codec errors propagate unchanged. Library-generated transport errors exclude response bodies and raw SDK errors. There are no automatic retries, background jobs, or automatic recovery.

## Development and validation

```sh
npm ci
npm run typecheck
npm test
npm run verify:java
npm run check:package
```

Tests cover SQLite execution, failure paths, rebuilds, concurrency and local Miniflare/Workerd R2/D1 bindings. `verify:java` requires Java 21+ and the Java checkout at `../r2d1`, or set `R2D1_JAVA_ROOT`. It compiles original source copies in a temporary directory and checks source hashes, fixtures and bidirectional cursors. It never builds or modifies the Java checkout. Normal tests use checked-in fixtures without Java.

The `Publish npm package` workflow is manually dispatched from `main`. The first formal release is `1.0.0`. Later runs increment the highest occupied stable version's patch component, checking both Git tags and the npm registry. The workflow updates both version files, validates Node 22 and 24, and atomically pushes a version commit and its `vX.Y.Z` tag. It uses the short-lived `GITHUB_TOKEN` for Git writes and OIDC for npm. No npm access token or PAT is configured.

The publish job keeps the workflow's `main` execution context for the `npm` Environment, while checking out the tag's exact commit SHA. It rechecks source ancestry, versions, tests and the tarball. An existing identical npm artifact is a successful no-op. A different artifact at the same version is an error. An unpublished tag is resumed without another version increment. Use the optional `resume_tag` input for explicit recovery of an existing tag. Re-running the same workflow run retains its release through the run ID recorded in the version commit.

The `npm` GitHub environment and package-level trusted publisher must be configured first. Repository rules must permit the workflow's short-lived token to update `main` and create release tags. The workflow never force-pushes, moves tags or creates GitHub releases. If Git reservation or npm publication fails, preserve existing tags and artifacts. Re-run all jobs to recover a reserved release, or use `resume_tag` from a new `main` dispatch. A new package may need separately authorized registration before package-level trust settings are available.

Live testing is opt-in and writes to dedicated resources. Set these variables:

```text
R2D1_IT_ALLOW_MUTATIONS=true
R2D1_IT_R2_ENDPOINT
R2D1_IT_R2_BUCKET_NAME
R2D1_IT_R2_ACCESS_KEY_ID
R2D1_IT_R2_SECRET_ACCESS_KEY
R2D1_IT_D1_ACCOUNT_ID
R2D1_IT_D1_DATABASE_ID
R2D1_IT_D1_API_TOKEN
```

Run `npm run test:live`. Without opt-in, it is skipped. Do not use production resources. It uses a unique collection, removes its document and rows, and prints its retained table name for manual removal. Local tests do not verify remote permissions, quotas, latency, or sustained load.

JDBC, filesystem storage, Java framework integrations, annotation processing, deployment automation, async indexing queues and distributed transactions are outside this package's scope.
