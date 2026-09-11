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
 * the later signing step starts from a clean binary — and re-applied only when no real signing
 * identity is configured; see {@link hasRealSigningIdentity}.
 */

import { execFileSync } from 'node:child_process';
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
 * True when the environment names a real macOS signing identity, in which case electron-builder
 * will sign the bundle itself once `afterPack` returns.
 *
 * Ad-hoc signing in that case is wasted work at best and harmful at worst: it rewrites the
 * bundle's `_CodeSignature` with a signature electron-builder then has to replace, and a build
 * that expects a Developer ID should fail loudly if that identity is missing rather than ship
 * something ad-hoc signed that looks fine locally. `CSC_IDENTITY_AUTO_DISCOVERY` is the one
 * that can go either way: explicitly `false` means "do not look for an identity", so the ad-hoc
 * signature is still needed.
 */
export function hasRealSigningIdentity(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.CSC_LINK !== undefined && env.CSC_LINK !== '') {
    return true;
  }
  if (env.CSC_KEY_PASSWORD !== undefined && env.CSC_KEY_PASSWORD !== '') {
    return true;
  }
  if (env.CSC_NAME !== undefined && env.CSC_NAME !== '') {
    return true;
  }
  const autoDiscovery = env.CSC_IDENTITY_AUTO_DISCOVERY;
  return autoDiscovery !== undefined && autoDiscovery !== '' && autoDiscovery.toLowerCase() !== 'false';
}

/**
 * Re-applies an ad-hoc signature to a macOS bundle whose binary was just re-written.
 *
 * `EnableEmbeddedAsarIntegrityValidation` makes the runtime check the asar against the hash in
 * `Info.plist`, and on macOS it only trusts that plist through the bundle's code signature —
 * so an app whose signature was invalidated by the fuse flip does not start at all (it hangs
 * before the first window, with nothing on stderr). Without a Developer ID this ad-hoc
 * signature is what makes the unsigned local build runnable at all; with one,
 * {@link hasRealSigningIdentity} skips this entirely and electron-builder signs properly.
 *
 * No `--deep`: Apple deprecated it years ago (it re-signs nested code with the *outer* bundle's
 * entitlements, which is exactly what you do not want for Electron's helper apps). Only the
 * main executable's signature was invalidated by the fuse flip — the nested helpers were not
 * touched — so signing the bundle itself is both sufficient and the supported spelling.
 */
function adHocSign(appBundle: string): void {
  execFileSync('codesign', ['--force', '--sign', '-', appBundle], { stdio: 'inherit' });
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
  if (context.electronPlatformName === 'darwin' && !hasRealSigningIdentity(process.env)) {
    adHocSign(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
  }
  process.stdout.write(`[fuses] flipped ${Object.keys(WIREBENCH_FUSES).length} fuses on ${binary}\n`);
}
