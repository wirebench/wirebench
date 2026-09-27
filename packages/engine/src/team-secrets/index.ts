export { decryptValue, encryptValue, newDataKey, unwrapDataKey, WRAP_INFO, wrapDataKey } from './envelope.js';
export { TEAM_SECRETS_MESSAGES, teamSecretsError } from './errors.js';
export type { TeamSecretsErrorCode } from './errors.js';
export {
  base32,
  base64url,
  encryptionPrivateKey,
  encryptionPublicKey,
  fingerprintOf,
  fromBase64url,
  generateMachineKeys,
  KEY_ID_PATTERN,
  keyIdOf,
  parseMachineKeys,
  serializeMachineKeys,
  signingPrivateKey,
  signingPublicKey,
} from './keys.js';
export type { MachineKeys, MachinePublicKeys } from './keys.js';
export { nextAccessEntryId, replayAccessLog, verifiedKeys } from './log.js';
export type { AccessState, KeyInfo, LogProblem, Removal } from './log.js';
export { vaultConflictWinner } from './resolve-conflict.js';
export {
  ACCESS_ACTIONS,
  accessEntryFileSchema,
  accessEntryPath,
  isTeamSecretsPath,
  isVaultEntryPath,
  keyIdSchema,
  keyRequestFileSchema,
  keyRequestPath,
  parseTeamSecretsFile,
  readTeamSecretsFiles,
  sameSecret,
  secretKeySchema,
  TEAM_SECRETS_ACCESS_DIR,
  TEAM_SECRETS_FORMAT_VERSION,
  TEAM_SECRETS_KEYS_DIR,
  TEAM_SECRETS_VALUES_DIR,
  teamSecretsFileText,
  ULID_PATTERN,
  vaultEntryFileSchema,
  vaultEntryId,
  vaultEntryIdOfPath,
  vaultEntryPath,
} from './schema.js';
export type {
  AccessAction,
  AccessEntryFile,
  KeyRequestFile,
  SecretKey,
  TeamSecretsFiles,
  VaultEntryFile,
} from './schema.js';
export { canonicalJson, signDocument, verifyDocument, withoutSignature } from './sign.js';
export type { Signed } from './sign.js';
export {
  approvedRecipients,
  buildVaultEntry,
  healVaultEntry,
  openVaultEntry,
  rotateMarks,
  rotateMarksFor,
  sealVaultEntry,
  verifyVaultEntry,
  wrapsUnapprovedKey,
} from './vault.js';
export type { RotateMark, VaultVerdict } from './vault.js';
