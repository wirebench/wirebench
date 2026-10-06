import { describe, expect, it } from 'vitest';
import { buildRst } from '../../../../src/wss/trust/rst.js';
import { createWssContext } from '../../../../src/wss/model.js';

describe('the Kerberos credential', () => {
  it('puts the AP-REQ into a GSS_Kerberosv5_AP_REQ BinarySecurityToken after the Timestamp', async () => {
    const rst = await buildRst(
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.corp/trust/13/windowstransport',
        soapVersion: '1.2',
        trustVersion: '1.3',
        tokenType: '2.0',
        keyType: 'bearer',
        credential: { kind: 'kerberos', spn: 'HTTP@sts.corp' },
        requestedLifetimeSeconds: 0,
      },
      {
        stsUrl: 'https://sts.corp/trust/13/windowstransport',
        appliesTo: 'https://service.corp/',
        ctx: createWssContext({ uuid: () => 'k1' }),
        kerberosToken: new Uint8Array([1, 2, 3]),
      },
    );
    expect(rst.xml).toMatch(/#GSS_Kerberosv5_AP_REQ"[^>]*>AQID<\/wsse:BinarySecurityToken>/);
    expect(rst.xml.indexOf('Timestamp')).toBeLessThan(rst.xml.indexOf('GSS_Kerberosv5_AP_REQ'));
  });
});
