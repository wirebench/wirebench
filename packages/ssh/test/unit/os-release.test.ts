import { describe, expect, it } from 'vitest';
import { detectOs } from '../../src/os-release.js';

describe('detectOs', () => {
  it('reads Ubuntu 22.04', () => {
    const text = `PRETTY_NAME="Ubuntu 22.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nID_LIKE=debian\n`;
    expect(detectOs(text)).toEqual({ id: 'ubuntu', name: 'Ubuntu', version: '22.04' });
  });
  it('reads RHEL 9', () => {
    const text = `NAME="Red Hat Enterprise Linux"\nVERSION_ID="9.3"\nID="rhel"\nID_LIKE="fedora"\n`;
    expect(detectOs(text)).toEqual({ id: 'rhel', name: 'Red Hat Enterprise Linux', version: '9.3' });
  });
  it('reads Rocky, Alpine, Amazon Linux 2023 and Debian', () => {
    expect(detectOs(`NAME="Rocky Linux"\nVERSION_ID="9.2"\nID="rocky"\nID_LIKE="rhel centos fedora"\n`)?.id).toBe(
      'rocky',
    );
    expect(detectOs(`NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.19.1\n`)).toEqual({
      id: 'alpine',
      name: 'Alpine Linux',
      version: '3.19.1',
    });
    expect(detectOs(`NAME="Amazon Linux"\nVERSION="2023"\nID="amzn"\nID_LIKE="fedora"\nVERSION_ID="2023"\n`)).toEqual({
      id: 'amazon',
      name: 'Amazon Linux',
      version: '2023',
    });
    expect(
      detectOs(`PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n`),
    ).toEqual({
      id: 'debian',
      name: 'Debian GNU/Linux',
      version: '12',
    });
  });
  it('maps almalinux, openSUSE and SLES', () => {
    expect(detectOs(`NAME="AlmaLinux"\nID="almalinux"\nID_LIKE="rhel centos fedora"\n`)?.id).toBe('alma');
    expect(detectOs(`NAME="openSUSE Leap"\nID="opensuse-leap"\nID_LIKE="suse opensuse"\n`)?.id).toBe('suse');
    expect(detectOs(`NAME="SLES"\nID="sles"\n`)?.id).toBe('suse');
  });
  it('falls back through ID_LIKE, then to linux', () => {
    expect(detectOs(`NAME="Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n`)?.id).toBe('ubuntu');
    expect(detectOs(`NAME="Weird OS"\nID=weird\nID_LIKE=debian\n`)).toEqual({ id: 'debian', name: 'Weird OS' });
    expect(detectOs(`NAME="Mystery"\nID=mystery\n`)).toEqual({ id: 'linux', name: 'Mystery' });
  });
  it('reads uname output', () => {
    expect(detectOs('Darwin\n')).toEqual({ id: 'macos', name: 'macOS' });
    expect(detectOs('FreeBSD\n')).toEqual({ id: 'freebsd', name: 'FreeBSD' });
  });
  it('reads a Windows ver banner', () => {
    expect(detectOs('\r\nMicrosoft Windows [Version 10.0.22631.3007]\r\n')).toEqual({
      id: 'windows',
      name: 'Windows',
      version: '10.0.22631.3007',
    });
  });
  it('is undefined for empty or unrecognised output', () => {
    expect(detectOs('')).toBeUndefined();
    expect(detectOs('  \n')).toBeUndefined();
    expect(detectOs('SunOS')).toBeUndefined();
  });
});
