/**
 * `CI_TOKEN_NAME_MAX_LENGTH`, restated; `test/callback-bounds.test.ts` pins it. Kept apart from
 * the `ci-tokens` store, which reaches `window`, so the node-side test project can import it.
 */
export const CI_TOKEN_NAME_MAX = 64;
