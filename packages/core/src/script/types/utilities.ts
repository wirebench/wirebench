/**
 * What every script has, a request's and a mock's dispatch script alike: hashing, encoding and the
 * log. The mock's dispatch prelude (`../../mock/script.ts`) defines the same globals.
 */
export const SCRIPT_UTILITIES = `
declare const crypto: {
  hash(algorithm: 'md5' | 'sha1' | 'sha256' | 'sha512', data: string, encoding?: 'hex' | 'base64'): string;
  hmac(algorithm: 'sha1' | 'sha256' | 'sha512', key: string, data: string, encoding?: 'hex' | 'base64'): string;
  randomUUID(): string;
};
declare const encoding: {
  base64(text: string): string;
  fromBase64(text: string): string;
  base64url(text: string): string;
  urlEncode(text: string): string;
};
declare function log(...values: unknown[]): void;
declare const console: {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
  debug(...values: unknown[]): void;
};
`;
