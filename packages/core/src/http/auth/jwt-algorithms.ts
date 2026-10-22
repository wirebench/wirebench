/**
 * The JWT signing algorithms (#348), apart from the signer so a schema can name them without
 * loading a JOSE library.
 */

/** Every algorithm a JWT can be signed with: HMAC, RSA PKCS#1 v1.5, ECDSA and RSA-PSS. */
export const JWT_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
] as const;

export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

/** True for the HMAC algorithms, which sign with a shared secret rather than a private key. */
export function isHmacAlgorithm(algorithm: JwtAlgorithm): boolean {
  return algorithm.startsWith('HS');
}
