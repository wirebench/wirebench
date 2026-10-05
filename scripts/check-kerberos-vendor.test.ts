import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkKerberosVendor } from './check-kerberos-vendor.ts';

async function resources(prebuilds: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'res-'));
  for (const prebuild of prebuilds) {
    await mkdir(join(dir, 'kerberos', prebuild), { recursive: true });
    await writeFile(join(dir, 'kerberos', prebuild, 'kerberos.node'), 'x');
  }
  return dir;
}

describe('checkKerberosVendor', () => {
  it('passes when every pinned prebuild of the platform is there', async () => {
    const dir = await resources(['linux-x64', 'linux-arm64']);
    expect(checkKerberosVendor({ platform: 'linux', resourcesDirs: [dir], loadHost: false })).toEqual([]);
  });

  it('names each missing binding', async () => {
    const dir = await resources(['linux-x64']);
    expect(checkKerberosVendor({ platform: 'linux', resourcesDirs: [dir], loadHost: false })).toEqual([
      `${join(dir, 'kerberos', 'linux-arm64', 'kerberos.node')} is missing`,
    ]);
  });

  it('accepts a Windows build with only the x64 binding, since there is no arm64 prebuild', async () => {
    const dir = await resources(['win32-x64']);
    expect(checkKerberosVendor({ platform: 'win32', resourcesDirs: [dir], loadHost: false })).toEqual([]);
  });

  it('checks every resources directory it is given', async () => {
    const complete = await resources(['win32-x64']);
    const empty = await resources([]);
    expect(checkKerberosVendor({ platform: 'win32', resourcesDirs: [complete, empty], loadHost: false })).toEqual([
      `${join(empty, 'kerberos', 'win32-x64', 'kerberos.node')} is missing`,
    ]);
  });
});

describe('checkKerberosVendor loading', () => {
  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'loads the host binding by absolute path, so a relative resources dir is not read as a package name',
    async () => {
      const dir = await resources(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
      const problems = checkKerberosVendor({
        platform: process.platform,
        resourcesDirs: [relative(process.cwd(), dir)],
        loadHost: true,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('does not load');
      expect(problems[0]).not.toContain('Cannot find module');
    },
  );
});
