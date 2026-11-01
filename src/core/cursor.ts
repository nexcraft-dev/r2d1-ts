import { key, long } from './model.js';
import type { IndexCursor, IndexValue } from './model.js';

/** Java UTF-8 replaces unpaired UTF-16 surrogates with '?'. */
export function javaUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(
    value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
      part.length === 2 ? part : '?',
    ),
  );
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function encodeCursor(cursor: IndexCursor): string {
  const documentKey = key(cursor.lastDocumentKey.collection, cursor.lastDocumentKey.id);
  const collection = javaUtf8(documentKey.collection);
  const id = javaUtf8(documentKey.id);
  const sort = cursor.sortValue;
  let payload = new Uint8Array();
  let tag = 0;
  if (sort) {
    switch (sort.type) {
      case 'string': {
        tag = 1;
        const text = javaUtf8(sort.value);
        payload = new Uint8Array(4 + text.length);
        new DataView(payload.buffer).setInt32(0, text.length);
        payload.set(text, 4);
        break;
      }
      case 'long':
        tag = 2;
        payload = new Uint8Array(8);
        new DataView(payload.buffer).setBigInt64(0, long(sort.value));
        break;
      case 'double':
        tag = 3;
        payload = new Uint8Array(8);
        new DataView(payload.buffer).setFloat64(0, sort.value);
        break;
      case 'boolean':
        tag = 4;
        payload = new Uint8Array([sort.value ? 1 : 0]);
        break;
      case 'timestamp':
        if (
          sort.seconds < -31557014167219200n ||
          sort.seconds > 31556889864403199n ||
          !Number.isInteger(sort.nanos) ||
          sort.nanos < 0 ||
          sort.nanos > 999999999
        )
          throw new TypeError('invalid timestamp');
        tag = 5;
        payload = new Uint8Array(12);
        new DataView(payload.buffer).setBigInt64(0, sort.seconds);
        new DataView(payload.buffer).setInt32(8, sort.nanos);
        break;
    }
  }
  const bytes = new Uint8Array(10 + collection.length + id.length + payload.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setInt32(1, collection.length);
  bytes.set(collection, 5);
  view.setInt32(5 + collection.length, id.length);
  bytes.set(id, 9 + collection.length);
  bytes[9 + collection.length + id.length] = tag;
  bytes.set(payload, 10 + collection.length + id.length);
  return base64(bytes);
}
export function decodeCursor(cursor: string): IndexCursor {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(cursor)) throw new TypeError();
    const binary = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    let offset = 0;
    const byte = (): number => view.getUint8(offset++);
    const string = (): string => {
      const length = view.getInt32(offset);
      offset += 4;
      if (length < 0 || length > bytes.length - offset) throw new TypeError();
      const value = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
        bytes.subarray(offset, offset + length),
      );
      offset += length;
      return value;
    };
    if (byte() !== 1) throw new TypeError();
    const lastDocumentKey = key(string(), string());
    let sortValue: IndexValue | undefined;
    switch (byte()) {
      case 0:
        break;
      case 1:
        sortValue = { type: 'string', value: string() };
        break;
      case 2:
        sortValue = { type: 'long', value: view.getBigInt64(offset) };
        offset += 8;
        break;
      case 3:
        sortValue = { type: 'double', value: view.getFloat64(offset) };
        offset += 8;
        break;
      case 4: {
        const value = byte();
        if (value > 1) throw new TypeError();
        sortValue = { type: 'boolean', value: value === 1 };
        break;
      }
      case 5: {
        let seconds = view.getBigInt64(offset);
        offset += 8;
        let nanos = view.getInt32(offset);
        offset += 4;
        // Instant.ofEpochSecond normalizes nanosecond adjustments.
        const carry = Math.floor(nanos / 1_000_000_000);
        seconds += BigInt(carry);
        nanos -= carry * 1_000_000_000;
        if (seconds < -31557014167219200n || seconds > 31556889864403199n) throw new TypeError();
        sortValue = { type: 'timestamp', seconds, nanos };
        break;
      }
      default:
        throw new TypeError();
    }
    if (offset !== bytes.length) throw new TypeError();
    return Object.freeze({
      lastDocumentKey,
      ...(sortValue ? { sortValue: Object.freeze(sortValue) } : {}),
    });
  } catch (cause) {
    throw new TypeError('invalid cursor', { cause });
  }
}
