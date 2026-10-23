/**
 * What a plugin call may hand back, checked before the host uses any of it (phase 7 spec §7). The
 * plugin API's own types (`ImportResult`, `GeneratedCode` in `@wirebench/engine/plugin`) are tied to
 * these by a type test.
 */
import { z } from 'zod';

const MAX_DEPTH = 16;

const nameValue = z.strictObject({ name: z.string().max(1024), value: z.string().max(1024 * 1024) });

const body = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('raw'), text: z.string(), contentType: z.string().max(256).optional() }),
  z.strictObject({ kind: z.literal('form'), fields: z.array(nameValue).max(1000) }),
]);

const request = z.strictObject({
  kind: z.literal('request'),
  name: z.string().min(1).max(256),
  method: z.string().regex(/^[A-Za-z]{1,16}$/),
  url: z
    .string()
    .max(8192)
    .refine((value) => /^https?:\/\//i.test(value) || /^\$\{[^}]+\}/.test(value), {
      message: 'must be an http(s) URL or start with a ${variable}',
    }),
  headers: z.array(nameValue).max(500).optional(),
  body: body.optional(),
  description: z
    .string()
    .max(64 * 1024)
    .optional(),
});

export interface PluginImportedFolder {
  readonly kind: 'folder';
  readonly name: string;
  readonly items: readonly PluginImportedItem[];
}
export type PluginImportedRequest = z.infer<typeof request>;
export type PluginImportedItem = PluginImportedFolder | PluginImportedRequest;

const item: z.ZodType<PluginImportedItem> = z.lazy(() =>
  z.union([
    request,
    z.strictObject({ kind: z.literal('folder'), name: z.string().min(1).max(256), items: z.array(item).max(10_000) }),
  ]),
);

const variable = nameValue.extend({ secret: z.boolean().optional() });

export const pluginImportResultSchema = z.strictObject({
  apis: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(256),
        description: z
          .string()
          .max(64 * 1024)
          .optional(),
        items: z.array(item).max(10_000),
      }),
    )
    .max(100),
  variables: z.array(variable).max(10_000).optional(),
  environments: z
    .array(z.strictObject({ name: z.string().min(1).max(256), variables: z.array(variable).max(10_000) }))
    .max(100)
    .optional(),
  report: z
    .strictObject({
      warnings: z.array(z.string().max(4096)).max(1000).optional(),
      notes: z.array(z.string().max(4096)).max(1000).optional(),
    })
    .optional(),
});

export type PluginImportData = z.infer<typeof pluginImportResultSchema>;

/** How deep `items` nests: deeper than {@link MAX_DEPTH} is refused. */
function depthOf(items: readonly PluginImportedItem[], at = 1): number {
  let deepest = at;
  for (const entry of items) if (entry.kind === 'folder') deepest = Math.max(deepest, depthOf(entry.items, at + 1));
  return deepest;
}

/** The checked result, or what is wrong with it. */
export function checkImportResult(
  value: unknown,
): { readonly ok: true; readonly result: PluginImportData } | { readonly ok: false; readonly message: string } {
  const parsed = pluginImportResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'not an import result'}` };
  }
  if (parsed.data.apis.some((api) => depthOf(api.items) > MAX_DEPTH)) {
    return { ok: false, message: `folders nest deeper than ${String(MAX_DEPTH)}` };
  }
  return { ok: true, result: parsed.data };
}

export const detectResultSchema = z.union([z.literal('definite'), z.literal('probable'), z.null()]);

export const generatedCodeSchema = z.strictObject({
  code: z.string(),
  notes: z.array(z.string().max(4096)).max(100),
});
