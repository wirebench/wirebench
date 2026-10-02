/**
 * The opaque page cursor (plan ruling 12): `base64url("<at ISO>|<id>")`. `(at, id)` is the table's
 * order, so a page continues exactly after the last row the client saw, whatever arrived meanwhile.
 */
import { cursorInvalid } from './errors.js';

export interface Cursor {
  readonly at: string;
  readonly id: string;
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(text: string): Cursor {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw cursorInvalid();
  const parts = Buffer.from(text, 'base64url').toString('utf8').split('|');
  const [at, id] = parts;
  if (parts.length !== 2 || at === undefined || id === undefined) throw cursorInvalid();
  if (Number.isNaN(Date.parse(at)) || !ULID.test(id)) throw cursorInvalid();
  return { at, id };
}
