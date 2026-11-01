import { StoredDocument } from './model.js';

export interface DocumentCodec<T> {
  serialize(document: T): StoredDocument;
  deserialize(document: StoredDocument): T;
}
/** Opt-in JSON only. Supply a decoder to validate untrusted data and restore domain types. */
export function jsonCodec<T>(decode: (value: unknown) => T): DocumentCodec<T> {
  return Object.freeze({
    serialize(document: T): StoredDocument {
      const json = JSON.stringify(document);
      if (json === undefined) throw new TypeError('document is not JSON serializable');
      return new StoredDocument(new TextEncoder().encode(json));
    },
    deserialize(document: StoredDocument): T {
      return decode(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document.content())) as unknown,
      );
    },
  });
}
