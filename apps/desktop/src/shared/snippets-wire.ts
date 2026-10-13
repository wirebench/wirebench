import { z } from 'zod';
import { sshProblemSchema } from './ssh-wire.js';

/**
 * Wire shapes of the workspace's `snippets.yaml` (SSH area, snippets slice). Scripts carry `${secret:NAME}`
 * tokens, never a value. The renderer does not import `@wirebench/ssh`, so the model is mirrored here with zod
 * alone; the renderer imports this file for its types only (the CSP trap: no eager value import).
 */

export const snippetVariableWireSchema = z.strictObject({
  name: z.string(),
  label: z.string().optional(),
  default: z.string().optional(),
});

/** A snippet as the file holds it, with its defaults filled in; a save leaves the defaults out of the file. */
export const snippetWireSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  variables: z.array(snippetVariableWireSchema),
  script: z.string(),
  enter: z.boolean(),
  confirm: z.boolean(),
});

export const snippetPackageWireSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  snippets: z.array(snippetWireSchema),
});

export const snippetsFileWireSchema = z.strictObject({
  version: z.literal(1),
  packages: z.array(snippetPackageWireSchema),
  snippets: z.array(snippetWireSchema),
});

/** One row of the flat list main derives from the file: what the Snippets view and the palette work with. */
export const snippetListItemWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  packageId: z.string().optional(),
  packageName: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  firstLine: z.string(),
  /** The first line up to its first `${`. */
  literalStart: z.string(),
  variables: z.array(snippetVariableWireSchema),
  /** Secret names the script uses; never a value. */
  secrets: z.array(z.string()),
  enter: z.boolean(),
  confirm: z.boolean(),
  lineCount: z.number(),
  /** SHA-256 of the saved snippet: a run refuses one that changed since. */
  revision: z.string(),
});

export const snippetProblemWireSchema = sshProblemSchema;

export const sshListSnippetsResponseSchema = z.object({
  file: snippetsFileWireSchema,
  snippets: z.array(snippetListItemWireSchema),
  problems: z.array(snippetProblemWireSchema),
});

export const sshSaveSnippetsRequestSchema = z.strictObject({ file: snippetsFileWireSchema });

/**
 * Types the **saved** snippet `snippetId` into a session this window owns. `revision` is the one the renderer
 * showed; `enter` can only turn the snippet's own Enter off; `skip` is how many characters the user already
 * typed (an inline suggestion). Values never hold a secret: secrets are resolved by main.
 */
export const sshRunSnippetRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  snippetId: z.string().min(1),
  revision: z.string(),
  values: z.record(z.string(), z.string()),
  bracketed: z.boolean(),
  enter: z.literal(false).optional(),
  skip: z.number().int().min(0).optional(),
});

export const sshPreviewSnippetRequestSchema = z.strictObject({
  snippetId: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

/** The expansion with every secret as `••••`, and the revision it was made from. */
export const sshPreviewSnippetResponseSchema = z.object({ text: z.string(), revision: z.string() });

export type SnippetVariableWire = z.infer<typeof snippetVariableWireSchema>;
export type SnippetWire = z.infer<typeof snippetWireSchema>;
export type SnippetPackageWire = z.infer<typeof snippetPackageWireSchema>;
export type SnippetsFileWire = z.infer<typeof snippetsFileWireSchema>;
export type SnippetListItemWire = z.infer<typeof snippetListItemWireSchema>;
export type SnippetProblemWire = z.infer<typeof snippetProblemWireSchema>;
export type SshListSnippetsResponse = z.infer<typeof sshListSnippetsResponseSchema>;
export type SshRunSnippetRequest = z.infer<typeof sshRunSnippetRequestSchema>;
export type SshPreviewSnippetRequest = z.infer<typeof sshPreviewSnippetRequestSchema>;
export type SshPreviewSnippetResponse = z.infer<typeof sshPreviewSnippetResponseSchema>;
