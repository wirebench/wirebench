/**
 * Resolves a SAML entry to the assertion it places: supplied XML, a form-built assertion, or a
 * token an STS issued. Whatever the source, the assertion is placed as it came: never given a
 * `wsu:Id`, never edited (spec §3.6).
 */
import { WssError } from '../../errors.js';
import { serializeXml } from '../../xml/serialize.js';
import { readAssertion } from '../saml/read.js';
import type {
  SamlConfirmation,
  SamlVersion,
  WssContext,
  WssIssuedTokenEntry,
  WssOutgoingConfig,
  WssSamlTokenEntry,
  WssSamlXmlEntry,
} from '../model.js';

/** What a later signature entry needs to know about a token placed before it. */
export interface PlacedSamlToken {
  readonly version: SamlVersion;
  readonly assertionId?: string;
  readonly attachedReferenceXml?: string;
  /** The certificate the token binds its holder to; a holder-of-key signature must use its key. */
  readonly proofCertPem?: string;
  readonly confirmation?: SamlConfirmation;
}

export interface ResolvedSamlToken {
  readonly assertionXml: string;
  readonly placed: PlacedSamlToken;
}

async function xmlOf(entry: WssSamlXmlEntry, ctx: WssContext): Promise<string> {
  let text: string;
  if (entry.file !== undefined) {
    if (ctx.projectFile === undefined) {
      throw new WssError('saml-token-file-missing', `The SAML token file "${entry.file}" cannot be read here.`, {
        details: { file: entry.file },
      });
    }
    text = await ctx.projectFile(entry.file);
  } else {
    text = entry.xml ?? '';
  }
  return entry.expandProperties && ctx.expand !== undefined ? ctx.expand(text) : text;
}

/**
 * @throws WssError `saml-token-invalid` | `saml-token-file-missing` | `ws-trust-unavailable`,
 * or what the issued-token source throws
 */
export async function resolveSamlToken(
  entry: WssSamlTokenEntry | WssIssuedTokenEntry,
  config: WssOutgoingConfig,
  ctx: WssContext,
): Promise<ResolvedSamlToken> {
  if (entry.kind === 'issued-token') {
    if (ctx.issuedTokens === undefined) {
      throw new WssError('ws-trust-unavailable', 'Issued tokens cannot be requested from here.');
    }
    const token = await ctx.issuedTokens.get(entry);
    return {
      assertionXml: token.assertionXml,
      placed: {
        version: token.samlVersion,
        ...(token.assertionId !== undefined ? { assertionId: token.assertionId } : {}),
        ...(token.attachedReferenceXml !== undefined ? { attachedReferenceXml: token.attachedReferenceXml } : {}),
        ...(token.proofCertPem !== undefined ? { proofCertPem: token.proofCertPem } : {}),
        confirmation: token.keyType === 'public-key' ? 'holder-of-key' : 'bearer',
      },
    };
  }
  if (entry.source === 'form') {
    void config;
    throw new WssError('wss-entry-unsupported', 'Form SAML tokens are not supported yet.');
  }
  const read = readAssertion(await xmlOf(entry, ctx));
  return {
    assertionXml: serializeXml(read.element),
    placed: {
      version: read.version,
      ...(read.id !== undefined ? { assertionId: read.id } : {}),
      ...(read.holderOfKeyCertPem !== undefined
        ? { proofCertPem: read.holderOfKeyCertPem, confirmation: 'holder-of-key' as const }
        : {}),
    },
  };
}
