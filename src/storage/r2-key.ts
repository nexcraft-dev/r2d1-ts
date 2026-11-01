import { javaUtf8 } from '../core/cursor.js';
import { key, text } from '../core/model.js';
import type { DocumentKey } from '../core/model.js';

function segment(value: string): string {
  return Array.from(javaUtf8(value), (byte) =>
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122) ||
    (byte >= 48 && byte <= 57) ||
    [45, 46, 95, 126].includes(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
  ).join('');
}
export function collectionPrefix(collection: string): string {
  return `${segment(text(collection, 'collection'))}/`;
}
export function objectKey(documentKey: DocumentKey): string {
  const validated = key(documentKey.collection, documentKey.id);
  return collectionPrefix(validated.collection) + segment(validated.id);
}
export function documentKeyFromObject(collection: string, object: string): DocumentKey {
  const prefix = collectionPrefix(collection);
  if (!object.startsWith(prefix)) throw new TypeError('object key is outside collection');
  const encoded = object.slice(prefix.length);
  if (!encoded || encoded.includes('/') || /[^\x00-\x7F]/.test(encoded))
    throw new TypeError('invalid object key');
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch (cause) {
    throw new TypeError('invalid object key encoding', { cause });
  }
  if (segment(id) !== encoded) throw new TypeError('object key is not canonical');
  return key(collection, id);
}
