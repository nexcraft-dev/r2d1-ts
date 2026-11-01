import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(process.env.R2D1_JAVA_ROOT ?? '../r2d1');
const target = resolve('test/fixtures/java.json');
const temporary = await mkdtemp(join(tmpdir(), 'r2d1-java-'));
const base = 'r2d1/src/main/java/dev/nexcraft/r2d1/';
const paths = [
  ...[
    'spi/DocumentKey.java',
    'spi/SpiValidation.java',
    'spi/IndexCursor.java',
    'spi/IndexValue.java',
    'spi/StoredDocument.java',
    'internal/persistence/CursorCodec.java',
    'r2/R2ObjectKey.java',
    'DocumentCodec.java',
    'annotation/Document.java',
    'annotation/Id.java',
    'annotation/Index.java',
    'Query.java',
    'Page.java',
    'SortDirection.java',
    'spi/IndexEntry.java',
    'spi/IndexQuery.java',
    'spi/IndexPage.java',
    'spi/StorageException.java',
    'd1/internal/metadata/D1CollectionMetadata.java',
    'd1/internal/metadata/D1IndexedField.java',
    'd1/internal/metadata/D1Metadata.java',
    'd1/internal/metadata/D1ValueType.java',
    'd1/internal/sql/D1SqlCompiler.java',
    'd1/internal/sql/D1Statement.java',
    'd1/internal/sql/D1Parameter.java',
    'd1/internal/sql/D1Result.java',
    'd1/internal/schema/D1SchemaManager.java',
  ].map((p) => base + p),
  ...['IntegrationDocuments.java', 'IntegrationDocumentCodec.java'].map(
    (p) =>
      'r2d1-integration-tests/src/integrationTest/java/dev/nexcraft/r2d1/integration/support/' + p,
  ),
];
const hashes = {};
async function put(path, content) {
  const location = join(temporary, path);
  await mkdir(dirname(location), { recursive: true });
  await writeFile(location, content);
  return location;
}
try {
  const sources = [];
  for (const path of paths) {
    const content = await readFile(join(root, path), 'utf8');
    hashes[path] = createHash('sha256').update(content).digest('hex');
    sources.push(await put(path, content));
  }
  sources.push(
    await put(
      'org/jspecify/annotations/Nullable.java',
      'package org.jspecify.annotations; @java.lang.annotation.Target({java.lang.annotation.ElementType.TYPE_USE}) public @interface Nullable {}',
    ),
  );
  // A network-free transport seam lets the original schema manager emit its DDL.
  sources.push(
    await put(
      'D1Transport.java',
      `package dev.nexcraft.r2d1.d1.internal.transport;
public interface D1Transport { java.util.concurrent.CompletionStage<dev.nexcraft.r2d1.d1.internal.sql.D1Result> execute(dev.nexcraft.r2d1.d1.internal.sql.D1Statement statement); }`,
    ),
  );
  sources.push(
    await put(
      'KeyProbe.java',
      `package dev.nexcraft.r2d1.r2;
import dev.nexcraft.r2d1.spi.DocumentKey;
public class KeyProbe { public static String encode(String collection,String id){return R2ObjectKey.from(new DocumentKey(collection,id));} }
`,
    ),
  );
  sources.push(
    await put(
      'Probe.java',
      `package dev.nexcraft.r2d1.internal.persistence;
import dev.nexcraft.r2d1.spi.*;
import dev.nexcraft.r2d1.r2.KeyProbe;
import dev.nexcraft.r2d1.integration.support.*;
import java.util.*;
import java.time.Instant;
import dev.nexcraft.r2d1.d1.internal.metadata.*;
import dev.nexcraft.r2d1.d1.internal.schema.*;
import dev.nexcraft.r2d1.d1.internal.sql.*;
import dev.nexcraft.r2d1.d1.internal.transport.*;
import dev.nexcraft.r2d1.SortDirection;
public class Probe {
 static String text(String value){return Base64.getEncoder().encodeToString(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));}
 static void statement(String kind,D1Statement value){System.out.println(kind+"\\t"+text(value.sql())+value.parameters().stream().map(p->"\\t"+text(p.wireValue())).collect(java.util.stream.Collectors.joining()));}
 public static void main(String[] args) {
  var key=new DocumentKey("users","user-1");
  IndexValue[] values={null,new IndexValue.StringValue("NZ/한글"),new IndexValue.LongValue(Long.MIN_VALUE),new IndexValue.LongValue(Long.MAX_VALUE),new IndexValue.DoubleValue(1.25),new IndexValue.BooleanValue(true),new IndexValue.BooleanValue(false),new IndexValue.TimestampValue(Instant.parse("2026-09-08T12:34:56.123456789Z"))};
  for(var value:values){var cursor=new IndexCursor(key,Optional.ofNullable(value));System.out.println("cursor\\t"+CursorCodec.encode(cursor));}
  String[][] keys={{"users","user-1"},{"a/b","x y%한글!"},{"users","../x"},{"users","a+b"},{"users","😀"}};
  for(var pair:keys)System.out.println("key\\t"+KeyProbe.encode(pair[0],pair[1]));
  var codec=new IntegrationDocumentCodec();
  var document=new IntegrationDocuments.PersistenceDocument("user/한글","NZ",Long.MIN_VALUE,"raw.😀");
  System.out.println("document\\t"+Base64.getEncoder().encodeToString(codec.serialize(document).content()));
  var metadata=D1Metadata.inspect(IntegrationDocuments.PersistenceDocument.class);
  var created=new boolean[]{false};
  var indexes=new HashSet<String>();
  D1Transport transport=sql->{
   List<Map<String,Object>> rows=new ArrayList<>();
   if(sql.sql().startsWith("CREATE TABLE")){statement("schema",sql);created[0]=true;}
   if(sql.sql().startsWith("PRAGMA table_info")&&created[0]){
    rows.add(Map.of("name","document_id","type","TEXT","notnull",1,"pk",1));
    for(var field:metadata.indexedFields())rows.add(Map.of("name",field.name(),"type",field.type().sqlType(),"notnull",1,"pk",0));
   }
   for(var field:metadata.indexedFields()){
    String name=D1Metadata.physicalIndexName(metadata.collection(),field.name());
    if(sql.sql().startsWith("CREATE INDEX")&&sql.sql().contains("\\\""+name+"\\\"")){statement("schema",sql);indexes.add(name);}
    if(sql.sql().startsWith("PRAGMA index_list")&&indexes.contains(name))rows.add(Map.of("name",name));
    if(sql.sql().equals("PRAGMA index_info(\\\""+name+"\\\")"))rows.add(Map.of("name",field.name()));
   }
   return java.util.concurrent.CompletableFuture.completedFuture(new D1Result(rows,0));
  };
  new D1SchemaManager(transport).initialize(metadata).toCompletableFuture().join();
  var compiler=new D1SqlCompiler();
  var storedKey=new DocumentKey(metadata.collection(),document.id());
  statement("upsert",compiler.upsert(metadata,new IndexEntry(storedKey,Map.of("country",new IndexValue.StringValue(document.country()),"rank",new IndexValue.LongValue(document.rank())))));
  var continuation=new IndexCursor(storedKey,Optional.of(new IndexValue.LongValue(Long.MIN_VALUE)));
  statement("query",compiler.query(metadata,new IndexQuery(metadata.collection(),List.of(),Optional.of(new IndexQuery.Sort("rank",SortDirection.ASC)),20,Optional.of(continuation))).statement());
  for(var input:args){var decoded=CursorCodec.decode(input);System.out.println("decoded\\t"+CursorCodec.encode(decoded));}
 }
}`,
    ),
  );
  execFileSync('javac', ['-d', join(temporary, 'classes'), ...sources], { stdio: 'pipe' });
  const { encodeCursor } = await import('../dist/index.js');
  const samples = [
    {},
    { sortValue: { type: 'string', value: 'NZ/한글' } },
    { sortValue: { type: 'long', value: -(1n << 63n) } },
    { sortValue: { type: 'long', value: (1n << 63n) - 1n } },
    { sortValue: { type: 'double', value: 1.25 } },
    { sortValue: { type: 'boolean', value: true } },
    { sortValue: { type: 'boolean', value: false } },
    { sortValue: { type: 'timestamp', seconds: 1788870896n, nanos: 123456789 } },
  ];
  const tokens = samples.map((sample) =>
    encodeCursor({ lastDocumentKey: { collection: 'users', id: 'user-1' }, ...sample }),
  );
  const output = execFileSync(
    'java',
    ['-cp', join(temporary, 'classes'), 'dev.nexcraft.r2d1.internal.persistence.Probe', ...tokens],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((line) => line.split('\t'));
  const cursors = output.filter(([kind]) => kind === 'cursor').map(([, value]) => value);
  const decoded = output.filter(([kind]) => kind === 'decoded').map(([, value]) => value);
  assert.deepEqual(decoded, tokens, 'Java must decode and re-encode TypeScript cursors');
  assert.deepEqual(cursors, tokens, 'TypeScript must produce the original Java wire bytes');
  const statements = output
    .filter(([kind]) => ['schema', 'upsert', 'query'].includes(kind))
    .map(([kind, sql, ...params]) => ({
      kind,
      sql: Buffer.from(sql, 'base64').toString(),
      params: params.map((p) => Buffer.from(p, 'base64').toString()),
    }));
  const fixtures = {
    referenceCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    sourceSha256: hashes,
    cursors,
    keys: output.filter(([kind]) => kind === 'key').map(([, value]) => value),
    documentBase64: output.find(([kind]) => kind === 'document')[1],
    statements,
  };
  if (process.argv.includes('--write')) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(fixtures, null, 2) + '\n');
  } else
    assert.deepEqual(
      fixtures,
      JSON.parse(await readFile(target, 'utf8')),
      'Checked-in fixtures must match the original Java sources',
    );
  console.log('PASS: original Java key/codec fixtures and bidirectional cursor compatibility');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
