/**
 * A host's operating system as a small mark: the system's own logo where one is published under a
 * free licence, a plain glyph otherwise (Windows), and a generic server for a host whose OS is not
 * known yet. Marks drawn in black or near-black take the text colour, so they read on a dark theme.
 */
import { Server } from 'lucide-react';
import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siLinux,
  siMacos,
  siOpensuse,
  siRedhat,
  siRockylinux,
  siUbuntu,
  type SimpleIcon,
} from 'simple-icons';
import type { SshHostOsWire, SshOsId } from '@shared/ssh-wire.js';

/** How each OS is named where it is chosen or shown in words. */
export const OS_LABELS: Readonly<Record<SshOsId, string>> = {
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  rhel: 'Red Hat Enterprise Linux',
  centos: 'CentOS',
  fedora: 'Fedora',
  rocky: 'Rocky Linux',
  alma: 'AlmaLinux',
  suse: 'SUSE',
  alpine: 'Alpine Linux',
  arch: 'Arch Linux',
  amazon: 'Amazon Linux',
  linux: 'Linux',
  macos: 'macOS',
  freebsd: 'FreeBSD',
  windows: 'Windows',
};

const MARKS: Readonly<Record<Exclude<SshOsId, 'windows'>, { readonly icon: SimpleIcon; readonly hex?: string }>> = {
  ubuntu: { icon: siUbuntu },
  debian: { icon: siDebian },
  rhel: { icon: siRedhat },
  centos: { icon: siCentos },
  fedora: { icon: siFedora },
  rocky: { icon: siRockylinux },
  alma: { icon: siAlmalinux },
  suse: { icon: siOpensuse },
  alpine: { icon: siAlpinelinux },
  arch: { icon: siArchlinux },
  // No published mark of its own: the Linux one, in the colour the system is known by.
  amazon: { icon: siLinux, hex: 'FF9900' },
  linux: { icon: siLinux },
  macos: { icon: siMacos },
  freebsd: { icon: siFreebsd },
};

/** A mark too dark to see on the dark theme takes the text colour instead. */
function colourOf(hex: string): string | undefined {
  const value = Number.parseInt(hex, 16);
  const luminance = 0.2126 * ((value >> 16) & 0xff) + 0.7152 * ((value >> 8) & 0xff) + 0.0722 * (value & 0xff);
  return luminance < 60 ? undefined : `#${hex}`;
}

/** The OS a host shows: the user's choice, else what the last connect found. */
export function osOf(entry: SshHostOsWire | undefined): SshOsId | undefined {
  return entry?.chosen ?? entry?.detected?.id;
}

/** The OS's words for a host: the detected name and version when it was detected, else the label. */
export function osTextOf(entry: SshHostOsWire | undefined): string | undefined {
  const os = osOf(entry);
  if (os === undefined) return undefined;
  const detected = entry?.detected;
  if (detected !== undefined && detected.id === os) {
    return detected.version === undefined ? detected.name : `${detected.name} ${detected.version}`;
  }
  return OS_LABELS[os];
}

export function OsIcon({ os, size }: { readonly os: SshOsId | undefined; readonly size: number }) {
  if (os === undefined) return <Server size={size} aria-hidden="true" />;
  if (os === 'windows') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="#0A7CD8">
        <rect x="2" y="2" width="9.5" height="9.5" />
        <rect x="12.5" y="2" width="9.5" height="9.5" />
        <rect x="2" y="12.5" width="9.5" height="9.5" />
        <rect x="12.5" y="12.5" width="9.5" height="9.5" />
      </svg>
    );
  }
  const mark = MARKS[os];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={colourOf(mark.hex ?? mark.icon.hex) ?? 'currentColor'}
    >
      <path d={mark.icon.path} />
    </svg>
  );
}
