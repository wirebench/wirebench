import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FuseV1Options } from '@electron/fuses';
import { electronBinaryPath, hasRealSigningIdentity, isUniversalTempDir, WIREBENCH_FUSES } from './fuses.ts';

describe('electronBinaryPath', () => {
  it('points inside the app bundle on macOS', () => {
    expect(electronBinaryPath('/out/mac-universal', 'darwin', 'Wirebench')).toBe(
      join('/out/mac-universal', 'Wirebench.app', 'Contents', 'MacOS', 'Wirebench'),
    );
  });

  it('is the .exe on Windows', () => {
    expect(electronBinaryPath('/out/win-unpacked', 'win32', 'Wirebench')).toBe(
      join('/out/win-unpacked', 'Wirebench.exe'),
    );
  });

  it('is the packager-reported executable name on Linux, else the lower-cased product name', () => {
    expect(electronBinaryPath('/out/linux-unpacked', 'linux', 'Wirebench')).toBe(
      join('/out/linux-unpacked', 'wirebench'),
    );
    expect(electronBinaryPath('/out/linux-unpacked', 'linux', 'Wirebench', '@wirebenchdesktop')).toBe(
      join('/out/linux-unpacked', '@wirebenchdesktop'),
    );
  });
});

describe('WIREBENCH_FUSES', () => {
  it('closes off every way to run foreign code in the packaged binary', () => {
    expect(WIREBENCH_FUSES).toEqual({
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
  });
});

describe('isUniversalTempDir', () => {
  it('recognises the per-architecture halves of a universal build', () => {
    expect(isUniversalTempDir('/out/mac-universal-x64-temp')).toBe(true);
    expect(isUniversalTempDir('/out/mac-universal-arm64-temp')).toBe(true);
  });

  it('does not recognise a directory that ships', () => {
    expect(isUniversalTempDir('/out/mac-universal')).toBe(false);
    expect(isUniversalTempDir('/out/win-unpacked')).toBe(false);
  });
});

describe('hasRealSigningIdentity', () => {
  it('is false with no signing environment at all', () => {
    expect(hasRealSigningIdentity({})).toBe(false);
    expect(hasRealSigningIdentity({ CSC_LINK: '', CSC_NAME: '' })).toBe(false);
  });

  it('is false with only a key password: that unlocks a certificate, it is not one', () => {
    expect(hasRealSigningIdentity({ CSC_KEY_PASSWORD: 'hunter2' })).toBe(false);
  });

  it('is true when a certificate or identity name is configured', () => {
    expect(hasRealSigningIdentity({ CSC_LINK: 'https://example.invalid/cert.p12' })).toBe(true);
    expect(hasRealSigningIdentity({ CSC_LINK: 'https://example.invalid/cert.p12', CSC_KEY_PASSWORD: 'hunter2' })).toBe(
      true,
    );
    expect(hasRealSigningIdentity({ CSC_NAME: 'Developer ID Application: Someone (TEAMID)' })).toBe(true);
  });

  it('treats auto-discovery as an identity unless it is explicitly disabled', () => {
    expect(hasRealSigningIdentity({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' })).toBe(true);
    expect(hasRealSigningIdentity({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' })).toBe(false);
    expect(hasRealSigningIdentity({ CSC_IDENTITY_AUTO_DISCOVERY: 'FALSE' })).toBe(false);
  });
});
