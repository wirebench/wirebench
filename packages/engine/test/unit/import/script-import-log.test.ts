/**
 * The import log's wording: a script that sends a request gets the advice to send it as a sequence
 * step, whichever client's call it uses.
 */
import { describe, expect, it } from 'vitest';
import { ScriptImportLog } from '#core/import/scripts';
import type { LayeredApi } from '#core/script/model';

const warningsFor = (api: LayeredApi, text: string): string[] => {
  const log = new ScriptImportLog(api);
  log.note({ api, enabled: false, secrets: [], pre: { text } }, 'request', 'Ping');
  return log.warnings();
};

describe('the send advice', () => {
  it.each([
    ['hoppscotch', 'await hopp.fetch("https://x.test");', 'hopp.fetch'],
    ['thunder-client', 'await tc.runRequest("abc");', 'tc.runRequest'],
    ['thunder-client', 'await tc.retryRequest();', 'tc.retryRequest'],
    ['bruno', 'await bru.runRequest("Login");', 'bru.runRequest'],
  ] as const)('%s: %s gets it', (api, text, call) => {
    expect(warningsFor(api, text)).toContain(
      `The scripts of "Ping" call ${call}, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token`,
    );
  });

  it('names every send call a script makes', () => {
    const warnings = warningsFor('thunder-client', 'tc.runRequest("a"); tc.retryRequest();');
    expect(warnings).toContain(
      'The scripts of "Ping" call tc.retryRequest and tc.runRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token',
    );
    expect(warnings.some((w) => w.includes('does not run'))).toBe(false);
  });
});
