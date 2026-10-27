import { useEffect, useState } from 'react';
import { ipc } from '../state/ipc-client.js';
import type { KeystoreAliasWire } from '@shared/wire-base.js';

/**
 * The alias names of one keystore, loaded through `keystores.inspect` — main reads the
 * keystore; the renderer only ever sees alias names and certificate metadata, never a key.
 */
export function useKeystoreAliases(keystoreRef: string): readonly KeystoreAliasWire[] {
  const [aliases, setAliases] = useState<readonly KeystoreAliasWire[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (keystoreRef === '') {
      setAliases([]);
      return undefined;
    }
    void (async () => {
      try {
        const result = await ipc().keystores.inspect({ keystoreId: keystoreRef });
        if (!cancelled) {
          setAliases(result.ok ? result.value.aliases : []);
        }
      } catch {
        if (!cancelled) {
          setAliases([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keystoreRef]);

  return aliases;
}
