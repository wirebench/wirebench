/**
 * The wire shapes of Settings → Plugins and of the places plugins appear (phase 7 spec §9, ADR-0031).
 * Only what manifests declare crosses to the renderer: ids, titles, versions, extensions, languages,
 * origins. No plugin code reaches it.
 */
import { z } from 'zod';

/** A plugin contribution's id as the registry spells it: `<plugin-id>/<contribution-id>`. */
export const PLUGIN_CONTRIBUTION_ID = /^[a-z0-9][a-z0-9-]{1,62}\/[a-z0-9][a-z0-9-]{0,62}$/;

const contributionSchema = z.object({ id: z.string(), title: z.string() });

/** One plugin as Settings lists it, or a folder the loader skipped and why. */
export const pluginRowWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  importers: z.array(contributionSchema.extend({ extensions: z.array(z.string()) })),
  reporters: z.array(contributionSchema.extend({ extension: z.string() })),
  codeGenerators: z.array(contributionSchema.extend({ language: z.string() })),
  network: z.array(z.string()),
  installedAt: z.string().optional(),
  /** Loaded in this run; false for one installed since start-up, which loads at the next. */
  loaded: z.boolean(),
});
export type PluginRowWire = z.infer<typeof pluginRowWireSchema>;

export const pluginsListResponseSchema = z.object({
  plugins: z.array(pluginRowWireSchema),
  skipped: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })),
  /** The `plugins` switch is off in this run: nothing was loaded. */
  off: z.boolean(),
});
export type PluginsListResponse = z.infer<typeof pluginsListResponseSchema>;

/** `plugins.stage`: a path the person just picked; main reads the plugin and holds it under a token. */
export const pluginsStageRequestSchema = z.object({ path: z.string().min(1) });
export const pluginsStageResponseSchema = z.object({
  token: z.string(),
  plugin: pluginRowWireSchema,
  /** The plugin it replaces, when one of that id is installed. */
  replaces: pluginRowWireSchema.optional(),
});
export type PluginsStageResponse = z.infer<typeof pluginsStageResponseSchema>;

export const pluginsInstallRequestSchema = z.object({ token: z.string() });
export const pluginsRemoveRequestSchema = z.object({ id: z.string() });

/** `api.detectPluginImport`: pasted or dropped text no built-in format claims. */
export const apiDetectPluginImportRequestSchema = z.object({
  text: z.string(),
  filename: z.string().optional(),
});
export const apiDetectPluginImportResponseSchema = z.object({
  /** `plugin:<plugin>/<importer>`, or `unknown`. */
  kind: z.string(),
  label: z.string(),
  confidence: z.enum(['definite', 'probable', 'unknown']),
});

/** `request.codeTargets`: the plugin code generators this run has on, after the built-in languages. */
export const requestCodeTargetsResponseSchema = z.object({
  targets: z.array(z.object({ id: z.string(), label: z.string(), language: z.string() })),
});
export type RequestCodeTargetsResponse = z.infer<typeof requestCodeTargetsResponseSchema>;
