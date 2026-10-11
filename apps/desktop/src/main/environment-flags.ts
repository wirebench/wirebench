/**
 * The colour and protection an environment patch carries (#345), shared by the project's and the
 * workspace's environment mutations.
 */

interface Flagged {
  readonly color?: string;
  readonly protected?: boolean;
}

/**
 * `environment` with `patch`'s colour and protection applied: an absent key keeps what it had,
 * `color: null` takes the colour off, and `protected: false` drops the flag (it is written only
 * when true).
 */
export function applyColorAndProtection<E extends Flagged>(
  environment: E,
  patch: { readonly color?: string | null | undefined; readonly protected?: boolean | undefined },
): E {
  const { color, protected: guarded, ...rest } = environment;
  const nextColor = patch.color === undefined ? color : (patch.color ?? undefined);
  const nextProtected = patch.protected ?? guarded;
  return {
    ...rest,
    ...(nextColor !== undefined ? { color: nextColor } : {}),
    ...(nextProtected === true ? { protected: true } : {}),
  } as E;
}
