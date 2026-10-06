/**
 * The fields of each secret-source kind, for the dialog's form. Kept here, with no imports, because the
 * renderer must not load the engine's zod schemas (secret sources plan, amendment A6); main validates every
 * save, and a test keeps this list in step with the engine's kinds.
 */
export const KIND_FIELDS: Readonly<
  Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = {
  vault: { required: ['path', 'field'], optional: ['mount', 'namespace'] },
  aws: { required: ['secretId'], optional: ['jsonKey', 'region', 'profile'] },
  gcp: { required: ['secret'], optional: ['project', 'version'] },
  azure: { required: ['vault', 'name'], optional: [] },
  '1password': { required: ['ref'], optional: [] },
  keychain: { required: ['service', 'account'], optional: [] },
  none: { required: [], optional: [] },
};
