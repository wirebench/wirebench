/** The webhook-capture module's configuration (spec §3.7), read once at registration. */
import type { HooksMeta } from '@wirebench/engine';
import type { ServerConfig } from '../config.js';

const MIB = 1024 * 1024;

export interface HooksSettings {
  /** `false`: neither the public route nor the management routes exist. */
  readonly enabled: boolean;
  /** How much of a body is stored; the request limit is the server's own `bodyLimitMb`. */
  readonly bodyLimitBytes: number;
  /** Captures kept per catch URL. */
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly ratePerSecond: number;
  readonly burst: number;
  /** Catch URLs per workspace. */
  readonly perWorkspace: number;
}

export function hooksSettings(config: ServerConfig): HooksSettings {
  return {
    enabled: config.hooksEnabled,
    bodyLimitBytes: config.hooksBodyLimitMb * MIB,
    keep: config.hooksKeep,
    maxAgeDays: config.hooksMaxAgeDays,
    ratePerSecond: config.hooksRatePerSecond,
    burst: config.hooksBurst,
    perWorkspace: config.hooksPerWorkspace,
  };
}

/** What `/meta` shows: what the desktop needs to show the node and explain truncation and retention. Never a secret. */
export function hooksMetaOf(settings: HooksSettings): HooksMeta {
  return {
    enabled: settings.enabled,
    bodyLimitBytes: settings.bodyLimitBytes,
    keep: settings.keep,
    maxAgeDays: settings.maxAgeDays,
  };
}
