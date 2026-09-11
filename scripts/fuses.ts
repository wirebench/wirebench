/**
 * electron-builder's `afterPack` hook: flips the Electron fuses on the packaged binary.
 *
 * Fuses are bits inside the Electron executable that turn off capabilities the runtime would
 * otherwise offer for free — running the binary as a plain Node interpreter, honouring
 * `NODE_OPTIONS`, attaching an inspector, loading the app from somewhere other than the asar.
 * Wirebench holds the user's endpoint credentials in the OS keychain, so every one of those is
 * a way to make the app run code it was never packaged with; the fuse wire is where they are
 * closed off for good, at build time, in the binary itself.
 *
 * This has to run *before* signing (which `afterPack` does — `afterSign` would be too late):
 * flipping a fuse rewrites bytes in the executable and invalidates any signature over it.
 * On macOS the ad-hoc signature electron-builder's own packing leaves behind is reset here so
 * the later signing step starts from a clean binary.
 */

import { join } from 'node:path';
import { FuseV1Options, FuseVersion, flipFuses } from '@electron/fuses';

/**
 * The fuse wire Wirebench ships, as an explicit table rather than a call site full of
 * arguments — the packaged e2e reads the fuses back off the built binary and compares them
 * against this exact object, so a fuse can never be quietly dropped.
 */
export const WIREBENCH_FUSES = {
  /** No `ELECTRON_RUN_AS_NODE`: the app binary is not a general-purpose Node interpreter. */
  [FuseV1Options.RunAsNode]: false,
  /** Cookies in the app's session are encrypted at rest with the OS credential store. */
  [FuseV1Options.EnableCookieEncryption]: true,
  /** `NODE_OPTIONS` cannot inject `--require` (or anything else) into the packaged app. */
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  /** No `--inspect`: a debugger cannot be attached to the shipped binary to read secrets. */
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  /** The asar's contents are hash-checked against the header embedded in the binary. */
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  /** App code is loaded from the asar only — never from an unpacked `app/` directory beside it. */
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
} as const;

/** The subset of electron-builder's `AfterPackContext` this hook reads. */
export interface FusesPackContext {
  /** Directory the platform's app bundle/tree was written to. */
  readonly appOutDir: string;
  /** `darwin`, `win32` or `linux`, as electron-builder names it. */
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

/**
 * Where the Electron executable lives inside a packed output directory, per platform.
 *
 * Pure and exported so a test can pin the three shapes without packaging anything: getting
 * this path wrong means `flipFuses` throws (or, worse, silently patches nothing).
 */
export function electronBinaryPath(appOutDir: string, platform: string, productFilename: string): string {
  if (platform === 'darwin') {
    return join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  if (platform === 'win32') {
    return join(appOutDir, `${productFilename}.exe`);
  }
  return join(appOutDir, productFilename.toLowerCase().replace(/ /g, '-'));
}

/**
 * True for the half-built per-architecture directories a macOS universal build packs before
 * merging them (`…/mac-universal-x64-temp`).
 *
 * Those two must stay byte-identical everywhere they are not a Mach-O binary, and flipping a
 * fuse resets the ad-hoc signature — which rewrites `_CodeSignature/CodeResources` differently
 * in each, and `@electron/universal` refuses to merge them ("Expected all non-binary files to
 * have identical SHAs"). The merged universal bundle gets its own `afterPack` call, which is
 * where the fuses belong anyway: it is the binary that ships.
 */
export function isUniversalTempDir(appOutDir: string): boolean {
  return /-(?:x64|arm64)-temp$/.test(appOutDir);
}

/**
 * Flips {@link WIREBENCH_FUSES} on the binary electron-builder just packed. A per-architecture
 * temp directory of a universal build is skipped; see {@link isUniversalTempDir}.
 *
 * @param context electron-builder's `AfterPackContext`
 */
export default async function afterPack(context: FusesPackContext): Promise<void> {
  if (isUniversalTempDir(context.appOutDir)) {
    return;
  }
  const binary = electronBinaryPath(
    context.appOutDir,
    context.electronPlatformName,
    context.packager.appInfo.productFilename,
  );
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // The ad-hoc signature over the un-fused binary is meaningless once bytes change; macOS
    // refuses to launch a binary whose signature no longer matches, so it is reset and the
    // (optional) real signing step later in the build puts a valid one back.
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    ...WIREBENCH_FUSES,
  });
  process.stdout.write(`[fuses] flipped ${Object.keys(WIREBENCH_FUSES).length} fuses on ${binary}\n`);
}
