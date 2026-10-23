/**
 * `wirebench-plugin.json` (phase 7 spec §6, ADR-0031): every contribution and capability a plugin has
 * is declared here, and nothing it does not declare is loaded. The type a plugin author writes against
 * is `PluginManifest` in `@wirebench/engine/plugin`; a type test keeps the two equal.
 */
import { z } from 'zod';

/** The plugin API major this build loads. `PLUGIN_API_VERSION`'s major, which a test checks. */
export const PLUGIN_API_MAJOR = 1;

export const MANIFEST_FILE = 'wirebench-plugin.json';

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const CONTRIBUTION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAIN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/;
const EXTENSION = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const title = z.string().trim().min(1).max(80);

/** An exact origin: `https://host[:port]`, nothing after it. */
const origin = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === value &&
        /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(url.hostname)
      );
    } catch {
      return false;
    }
  },
  { message: 'must be an origin such as https://schemas.example.com, with no path' },
);

const unique = <T extends { readonly id: string }>(items: readonly T[] | undefined): boolean =>
  items === undefined || new Set(items.map((item) => item.id)).size === items.length;

export const pluginManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(1),
    id: z.string().regex(PLUGIN_ID, 'must match ^[a-z0-9][a-z0-9-]{1,62}$'),
    name: title,
    version: z.string().regex(SEMVER, 'must be semver'),
    api: z.number().int().positive(),
    main: z.string().regex(MAIN, 'must be a .js file beside the manifest'),
    description: z.string().max(500).optional(),
    contributes: z.strictObject({
      importers: z
        .array(
          z.strictObject({
            id: z.string().regex(CONTRIBUTION_ID),
            title,
            extensions: z.array(z.string().regex(EXTENSION)).max(16).optional(),
          }),
        )
        .max(16)
        .optional(),
      reporters: z
        .array(z.strictObject({ id: z.string().regex(CONTRIBUTION_ID), title, extension: z.string().regex(EXTENSION) }))
        .max(16)
        .optional(),
      codeGenerators: z
        .array(
          z.strictObject({
            id: z.string().regex(CONTRIBUTION_ID),
            title,
            language: z.string().regex(/^[a-z0-9][a-z0-9+#-]{0,31}$/),
          }),
        )
        .max(16)
        .optional(),
    }),
    capabilities: z.strictObject({ network: z.array(origin).max(16).optional() }).optional(),
  })
  .refine((manifest) => unique(manifest.contributes.importers), { message: 'two importers share an id' })
  .refine((manifest) => unique(manifest.contributes.reporters), { message: 'two reporters share an id' })
  .refine((manifest) => unique(manifest.contributes.codeGenerators), { message: 'two code generators share an id' })
  .refine(
    (manifest) =>
      (manifest.contributes.importers?.length ?? 0) +
        (manifest.contributes.reporters?.length ?? 0) +
        (manifest.contributes.codeGenerators?.length ?? 0) >
      0,
    { message: 'contributes nothing' },
  )
  .refine(
    (manifest) =>
      (manifest.capabilities?.network?.length ?? 0) === 0 || (manifest.contributes.importers?.length ?? 0) > 0,
    // A reporter or code generator is handed data an origin list cannot keep in (spec §8).
    { message: 'only a plugin with an importer may list network origins' },
  );

export type PluginManifestData = z.infer<typeof pluginManifestSchema>;

/** The manifest in `text`, or what is wrong with it, one line per problem. */
export function parsePluginManifest(
  text: string,
):
  | { readonly ok: true; readonly manifest: PluginManifestData }
  | { readonly ok: false; readonly problems: readonly string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problems: [`${MANIFEST_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = pluginManifestSchema.safeParse(json);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}
