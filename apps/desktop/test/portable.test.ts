import { describe, expect, it } from 'vitest';
import { portableDataDir } from '../src/main/portable.js';

const exePath = 'E:\\Tools\\Wirebench-4.1.0-windows-x64-portable\\Wirebench.exe';
const dataDir = 'E:\\Tools\\Wirebench-4.1.0-windows-x64-portable\\data';

describe('portableDataDir', () => {
  it('uses the data folder beside a packaged Windows executable', () => {
    const seen: string[] = [];
    const isDirectory = (path: string): boolean => {
      seen.push(path);
      return true;
    };
    expect(portableDataDir({ platform: 'win32', isPackaged: true, exePath, isDirectory })).toBe(dataDir);
    expect(seen).toEqual([dataDir]);
  });

  it('is not portable without the data folder', () => {
    expect(portableDataDir({ platform: 'win32', isPackaged: true, exePath, isDirectory: () => false })).toBeUndefined();
  });

  it('never looks on other systems or in a development run', () => {
    const isDirectory = (): boolean => {
      throw new Error('should not be called');
    };
    expect(portableDataDir({ platform: 'darwin', isPackaged: true, exePath, isDirectory })).toBeUndefined();
    expect(portableDataDir({ platform: 'linux', isPackaged: true, exePath, isDirectory })).toBeUndefined();
    expect(portableDataDir({ platform: 'win32', isPackaged: false, exePath, isDirectory })).toBeUndefined();
  });

  it('treats a missing path as not portable with the default check', () => {
    const missing = 'Z:\\definitely\\not\\here\\Wirebench.exe';
    expect(portableDataDir({ platform: 'win32', isPackaged: true, exePath: missing })).toBeUndefined();
  });
});
