import { StoredDocument, defineSchema } from '@nexcraft-dev/r2d1';
import type { DocumentCodec } from '@nexcraft-dev/r2d1';

export interface User {
  id: string;
  country: string;
  rank: bigint;
  payload: string;
}
export const schema = defineSchema<User>({
  collection: 'users',
  id: 'id',
  indexes: { country: 'string', rank: 'long' },
});
function encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): string {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  );
}
/** Matches the Java reference project's IntegrationDocumentCodec, not a universal Java format. */
export const codec: DocumentCodec<User> = {
  serialize(value) {
    return new StoredDocument(
      new TextEncoder().encode(
        [
          encode(value.id),
          encode(value.country),
          value.rank.toString(),
          encode(value.payload),
        ].join('.'),
      ),
    );
  },
  deserialize(document) {
    const fields = new TextDecoder('utf-8', { fatal: true }).decode(document.content()).split('.');
    if (fields.length !== 4 || !/^-?\d+$/.test(fields[2]!))
      throw new TypeError('Invalid integration document encoding');
    const rank = BigInt(fields[2]!);
    if (rank < -(1n << 63n) || rank >= 1n << 63n) throw new TypeError('Invalid Long');
    return {
      id: decode(fields[0]!),
      country: decode(fields[1]!),
      rank,
      payload: decode(fields[3]!),
    };
  },
};
