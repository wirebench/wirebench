/**
 * The JWS algorithms Wirebench signs with (RFC 7518 §3.1), in a module with no imports so a schema
 * can name them without pulling `node:crypto` into a bundle. `none` is deliberately absent.
 */
export const JWT_ALGS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;
export type JwtAlg = (typeof JWT_ALGS)[number];
