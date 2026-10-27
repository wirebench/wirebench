/**
 * The JWT signing algorithms (#348) as plain data, so the wire schema and the renderer's editor can
 * name them without importing the engine. A main-process test keeps this list equal to the engine's.
 */
export const JWT_ALGORITHM_NAMES = [
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

export type JwtAlgorithmName = (typeof JWT_ALGORITHM_NAMES)[number];
