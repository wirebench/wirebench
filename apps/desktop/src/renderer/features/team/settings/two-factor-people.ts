/**
 * Who has two-step sign-in on a server (two-step sign-in spec §6, §7), for a server admin only: the People badge and
 * reset, and the Sign-in page's count of password users without a second step. Anyone else, or a server older than
 * two-step sign-in, gets nothing, and the badge and count stay hidden.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AccountServerPersonWire } from '@shared/wire-base.js';
import { ipc } from '../../../state/ipc-client.js';

export interface ServerPeople {
  /** By user id; `undefined` until read, or when the server does not answer this person. */
  readonly people: ReadonlyMap<string, AccountServerPersonWire> | undefined;
  readonly reload: () => Promise<void>;
}

export function useServerPeople(url: string | undefined, serverAdmin: boolean): ServerPeople {
  const [people, setPeople] = useState<ReadonlyMap<string, AccountServerPersonWire> | undefined>(undefined);

  const reload = useCallback(async (): Promise<void> => {
    if (url === undefined || !serverAdmin) {
      setPeople(undefined);
      return;
    }
    const result = await ipc().account.serverPeople({ url });
    setPeople(result.ok ? new Map(result.value.people.map((person) => [person.userId, person])) : undefined);
  }, [url, serverAdmin]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { people, reload };
}

/** People who sign in with a password and have no second step yet, disabled accounts left out (spec §6). */
export function withoutSecondStep(people: ReadonlyMap<string, AccountServerPersonWire>): number {
  let count = 0;
  for (const person of people.values()) if (person.password && !person.twoFactor && !person.disabled) count += 1;
  return count;
}
