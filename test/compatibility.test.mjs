import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodeCursor, decodeCursor, StoredDocument } from '../dist/index.js';
import { objectKey, documentKeyFromObject } from '../dist/storage/r2-key.js';

const fixtures = JSON.parse(
  await readFile(new URL('./fixtures/java.json', import.meta.url), 'utf8'),
);
test('original Java cursors round-trip byte-for-byte including every SPI tag and int64 extrema', () => {
  for (const cursor of fixtures.cursors) assert.equal(encodeCursor(decodeCursor(cursor)), cursor);
  assert.equal(decodeCursor(fixtures.cursors[2]).sortValue.value, -(1n << 63n));
  assert.equal(decodeCursor(fixtures.cursors[3]).sortValue.value, (1n << 63n) - 1n);
});
test('R2 keys match executed Java source fixtures and reject foreign or noncanonical keys', () => {
  const inputs = [
    ['users', 'user-1'],
    ['a/b', 'x y%한글!'],
    ['users', '../x'],
    ['users', 'a+b'],
    ['users', '😀'],
  ];
  inputs.forEach(([collection, id], i) => {
    assert.equal(objectKey({ collection, id }), fixtures.keys[i]);
    assert.deepEqual(documentKeyFromObject(collection, fixtures.keys[i]), { collection, id });
  });
  for (const invalid of [
    'other/a',
    'users/a/b',
    'users/%61',
    'users/%ff',
    'users/%2f',
    'users/한글',
    'users/',
    'users/%',
  ])
    assert.throws(() => documentKeyFromObject('users', invalid));
});
test('Java application codec bytes remain unchanged and decode without an invented envelope', () => {
  const stored = new StoredDocument(Buffer.from(fixtures.documentBase64, 'base64'));
  const fields = new TextDecoder().decode(stored.content()).split('.');
  const value = {
    id: Buffer.from(fields[0], 'base64url').toString(),
    country: Buffer.from(fields[1], 'base64url').toString(),
    rank: BigInt(fields[2]),
    payload: Buffer.from(fields[3], 'base64url').toString(),
  };
  assert.deepEqual(value, {
    id: 'user/한글',
    country: 'NZ',
    rank: -(1n << 63n),
    payload: 'raw.😀',
  });
  const encoded = [
    Buffer.from(value.id).toString('base64url'),
    Buffer.from(value.country).toString('base64url'),
    value.rank.toString(),
    Buffer.from(value.payload).toString('base64url'),
  ].join('.');
  assert.equal(Buffer.from(encoded).toString('base64'), fixtures.documentBase64);
});
test('invalid cursor versions, tags, booleans, lengths and trailing bytes fail', () => {
  const original = Buffer.from(fixtures.cursors[0], 'base64url');
  const invalid = [
    Buffer.from([2, ...original.subarray(1)]),
    Buffer.concat([original, Buffer.from([0])]),
    original.subarray(0, -1),
    Buffer.from([1, 255, 255, 255, 255]),
    Buffer.from([...original.subarray(0, -1), 99]),
    Buffer.from([...original.subarray(0, -1), 4, 2]),
  ];
  for (const bytes of invalid)
    assert.throws(() => decodeCursor(bytes.toString('base64url')), /invalid cursor/);
  for (const text of ['', '***', 'a', 'AAAA\n'])
    assert.throws(() => decodeCursor(text), /invalid cursor/);
});
