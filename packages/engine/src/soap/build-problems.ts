/** Non-fatal problems the sample-request builder reports instead of throwing. */

/** Machine-readable kinds of {@link BuildProblem}. */
export type BuildProblemCode =
  | 'unknown-operation'
  | 'unknown-binding'
  | 'unsupported-binding'
  | 'missing-part'
  | 'unknown-element'
  | 'unknown-type'
  | 'missing-portType'
  | 'missing-message';

/**
 * A problem encountered while building a sample request. The builder is
 * deliberately total — it always returns an envelope, however degraded — so
 * the UI can show a partial request alongside what is wrong with it.
 */
export interface BuildProblem {
  readonly code: BuildProblemCode;
  readonly message: string;
}
