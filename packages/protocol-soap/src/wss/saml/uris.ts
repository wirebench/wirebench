/**
 * The URIs the SAML token profile, SAML itself and the two WS-Trust versions this build speaks
 * use as identifiers. Kept apart from `xml/namespaces.ts` because none of them is a namespace.
 */
import type { IssuedKeyType, SamlConfirmation, SamlVersion, WsTrustVersion } from '../model.js';

/** `wsse11:TokenType` / `wst:TokenType`, by SAML version (WSS SAML token profile 1.1). */
export const SAML_TOKEN_TYPE: Record<SamlVersion, string> = {
  '1.1': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV1.1',
  '2.0': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLV2.0',
};

/** The `wsse:KeyIdentifier` `ValueType` that names an assertion by its id, by SAML version. */
export const SAML_KEY_IDENTIFIER_VALUE_TYPE: Record<SamlVersion, string> = {
  '1.1': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.0#SAMLAssertionID',
  '2.0': 'http://docs.oasis-open.org/wss/oasis-wss-saml-token-profile-1.1#SAMLID',
};

/** `SubjectConfirmation` methods, by SAML version. */
export const SAML_CONFIRMATION_METHOD: Record<SamlVersion, Record<SamlConfirmation, string>> = {
  '1.1': {
    bearer: 'urn:oasis:names:tc:SAML:1.0:cm:bearer',
    'holder-of-key': 'urn:oasis:names:tc:SAML:1.0:cm:holder-of-key',
    'sender-vouches': 'urn:oasis:names:tc:SAML:1.0:cm:sender-vouches',
  },
  '2.0': {
    bearer: 'urn:oasis:names:tc:SAML:2.0:cm:bearer',
    'holder-of-key': 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
    'sender-vouches': 'urn:oasis:names:tc:SAML:2.0:cm:sender-vouches',
  },
};

/** The default authentication context for a form assertion's `AuthnStatement`. */
export const SAML_AUTHN_CONTEXT_UNSPECIFIED = 'urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified';
export const SAML1_AUTHN_METHOD_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.0:am:unspecified';

/** The STR-Transform (WSS SOAP Message Security 1.0 §8.3). */
export const STR_TRANSFORM =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#STR-Transform';

/** The Kerberos token profile's AP-REQ value type. */
export const KERBEROS_AP_REQ_VALUE_TYPE =
  'http://docs.oasis-open.org/wss/oasis-wss-kerberos-token-profile-1.1#GSS_Kerberosv5_AP_REQ';

/** What differs between WS-Trust 1.3 and the February 2005 draft. */
export interface TrustUris {
  readonly namespace: string;
  readonly issueAction: string;
  readonly requestTypeIssue: string;
  readonly keyType: Record<IssuedKeyType, string>;
}

export const TRUST_URIS: Record<WsTrustVersion, TrustUris> = {
  '1.3': {
    namespace: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512',
    issueAction: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue',
    requestTypeIssue: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/Issue',
    keyType: {
      bearer: 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/Bearer',
      'public-key': 'http://docs.oasis-open.org/ws-sx/ws-trust/200512/PublicKey',
    },
  },
  '2005-02': {
    namespace: 'http://schemas.xmlsoap.org/ws/2005/02/trust',
    issueAction: 'http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue',
    requestTypeIssue: 'http://schemas.xmlsoap.org/ws/2005/02/trust/Issue',
    keyType: {
      // The 2005/02 draft defines no bearer key type; deployments of it use this identity URI.
      bearer: 'http://schemas.xmlsoap.org/ws/2005/05/identity/NoProofKey',
      'public-key': 'http://schemas.xmlsoap.org/ws/2005/02/trust/PublicKey',
    },
  },
};
