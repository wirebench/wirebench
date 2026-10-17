/**
 * Builds the device helper (#428) into apps/desktop/build-resources/device-helper/, where electron-builder
 * picks it up as an extra resource (`Resources/device-helper/` in the packed app) and dev runs find it.
 *
 * - darwin: compiles `apps/desktop/native/device-helper/macos/main.swift` for arm64 and x86_64 with `swiftc`
 *   (Xcode's command line tools), joins them with `lipo` into one universal binary, the same file in the x64,
 *   arm64 and universal apps, and signs it ad hoc. The release signs it again with the app's identity.
 * - win32: copies `apps/desktop/native/device-helper/windows/device-helper.ps1`; it runs in Windows
 *   PowerShell, which ships with Windows, so nothing is compiled.
 * - linux: nothing; device keys are not offered there.
 *
 *   node scripts/build-device-helper.ts [darwin|linux|win32]
 *   node scripts/build-device-helper.ts check <darwin|win32> <packed app's Resources folder>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'apps', 'desktop', 'native', 'device-helper');
export const DEFAULT_OUT_DIR = join(ROOT, 'apps', 'desktop', 'build-resources', 'device-helper');

/** The file main runs on each platform, inside the device-helper folder. */
export const HELPER_FILE = { darwin: 'wirebench-device-helper', win32: 'device-helper.ps1' } as const;

type Platform = 'darwin' | 'linux' | 'win32';
/** The oldest macOS the helper runs on: CryptoKit's Secure Enclave keys and Electron's own floor. */
const MACOS_TARGET = '13.0';

export async function buildDeviceHelper(
  platform: Platform,
  outDir: string = DEFAULT_OUT_DIR,
): Promise<string | undefined> {
  if (platform === 'linux') return undefined;
  await mkdir(outDir, { recursive: true });
  const target = join(outDir, HELPER_FILE[platform]);
  if (platform === 'win32') {
    await copyFile(join(SOURCES, 'windows', 'device-helper.ps1'), target);
    return target;
  }
  const work = await mkdtemp(join(tmpdir(), 'wb-device-helper-'));
  try {
    const source = join(SOURCES, 'macos', 'main.swift');
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const out = join(work, arch);
      execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos${MACOS_TARGET}`, source, '-o', out], {
        stdio: 'inherit',
      });
      return out;
    });
    execFileSync('lipo', ['-create', ...slices, '-output', target], { stdio: 'inherit' });
    // swiftc already signs ad hoc on Apple Silicon; signing the joined file again only says so on stderr.
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return target;
}

/**
 * Checks that a packed app carries the helper: on macOS, a universal binary with both slices.
 *
 * @returns the problems found; none means the app is fine
 */
export function checkPackedHelper(platform: 'darwin' | 'win32', resources: string): string[] {
  const file = join(resources, 'device-helper', HELPER_FILE[platform]);
  if (!existsSync(file)) return [`${file} is missing`];
  if (platform === 'win32') return [];
  const archs = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/).sort();
  return archs.join(' ') === 'arm64 x86_64' ? [] : [`${file} has slices "${archs.join(' ')}", not arm64 and x86_64`];
}

if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === 'check') {
    const [, , , platform, resources] = process.argv;
    if ((platform !== 'darwin' && platform !== 'win32') || resources === undefined) {
      console.error('device-helper: usage: check <darwin|win32> <Resources folder>');
      process.exit(1);
    }
    const problems = checkPackedHelper(platform, resources);
    for (const problem of problems) console.error(`device-helper: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log(`device-helper: ${platform} helper present`);
  } else {
    const requested = process.argv[2] ?? process.platform;
    if (requested !== 'darwin' && requested !== 'linux' && requested !== 'win32') {
      console.error(`device-helper: unsupported platform "${requested}"; use darwin, linux or win32.`);
      process.exit(1);
    }
    if (requested === 'darwin' && process.platform !== 'darwin') {
      console.error('device-helper: the macOS helper is compiled on macOS only');
      process.exit(1);
    }
    const built = await buildDeviceHelper(requested);
    console.log(built === undefined ? `device-helper: none for ${requested}` : `device-helper: ${built}`);
  }
}
