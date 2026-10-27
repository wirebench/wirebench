// Kept apart from wire-types.ts so the renderer can read the limit without loading the zod
// schemas at start-up, before main.tsx has switched zod to jitless mode.

/** The most environments one `request.sendToEnvironments` fans out to. */
export const MAX_SEND_ENVIRONMENTS = 10;
