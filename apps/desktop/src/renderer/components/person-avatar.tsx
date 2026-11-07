/**
 * A person's avatar (user profile spec §4): their photo when they have one, else their initials. Used wherever the
 * renderer shows a person — the account menu, People rows, the Team dialog's members tab, the profile card. The
 * image is decorative (`alt=""`): the person's name is always shown beside it.
 */
import { useEffect, useState } from 'react';
import type { AccountImageKindWire } from '@shared/wire-base.js';
import { loadPersonImage, settledPersonImage } from '../state/person-images.js';

/** `xs` (16 px) fits the 24 px status bar; `sm` 24, `md` 32 and `lg` 96 are the spec's sizes. */
export type PersonAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_CLASS: Readonly<Record<PersonAvatarSize, string>> = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-24 w-24 text-2xl',
};

/** "Ada Lovelace" → "AL", "ada" → "AD", "" → "?". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The `data:` URL of one person's image, or `undefined` while it loads, when they have none, or when it failed (the
 * caller then shows its fallback). A version change loads the new image; the old one stays until it arrives.
 */
export function usePersonImage(
  url: string | undefined,
  userId: string | undefined,
  kind: AccountImageKindWire,
  version: string | undefined,
): string | undefined {
  const ref =
    url === undefined || userId === undefined || version === undefined ? undefined : { url, userId, kind, version };
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly dataUrl: string } | undefined>(undefined);
  const key = ref === undefined ? undefined : `${ref.url}|${ref.userId}|${ref.kind}|${ref.version}`;

  useEffect(() => {
    if (ref === undefined || key === undefined) return;
    let live = true;
    loadPersonImage(ref).then(
      (dataUrl) => {
        if (live) setLoaded({ key, dataUrl });
      },
      () => {
        if (live) setLoaded(undefined);
      },
    );
    return () => {
      live = false;
    };
    // `key` spells out every field of `ref`, so it alone decides when to load again.
  }, [key]);

  if (ref === undefined) return undefined;
  if (loaded !== undefined && loaded.key === key) return loaded.dataUrl;
  return settledPersonImage(ref);
}

export interface PersonAvatarProps {
  /** The server the person is on; with `userId` and `photo` it names the image. */
  readonly url: string | undefined;
  readonly userId: string | undefined;
  /** For the initials. */
  readonly name: string;
  readonly photo: { readonly version: string } | null | undefined;
  readonly size?: PersonAvatarSize;
  readonly className?: string;
  readonly testId?: string;
}

export function PersonAvatar({ url, userId, name, photo, size = 'md', className = '', testId }: PersonAvatarProps) {
  const dataUrl = usePersonImage(url, userId, 'photo', photo?.version ?? undefined);
  const base = `${SIZE_CLASS[size]} shrink-0 rounded-full ${className}`;
  if (dataUrl !== undefined) {
    return (
      <img
        src={dataUrl}
        alt=""
        data-testid={testId}
        data-avatar="photo"
        className={`${base} object-cover`}
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-avatar="initials"
      className={`${base} flex items-center justify-center bg-accent-muted font-medium text-fg-default`}
    >
      {initials(name)}
    </span>
  );
}
