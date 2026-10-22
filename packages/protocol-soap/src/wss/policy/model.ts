/**
 * What a WSDL's WS-SecurityPolicy says one operation's request must look like, reduced to the
 * handful of facts an outgoing WS-Security configuration can act on. Plain data only, so it
 * travels to the renderer as it is.
 */

/** The X.509 key identifier forms a policy can ask for; mirrors `WssX509KeyIdentifierType`. */
export type WssPolicyKeyReference =
  'BinarySecurityToken' | 'IssuerSerial' | 'SubjectKeyIdentifier' | 'X509KeyIdentifier' | 'Thumbprint';

/** Where a token sits in the policy: a binding's own token, or one of the supporting-token lists. */
export type WssPolicyTokenRole =
  'initiator' | 'recipient' | 'supporting' | 'signed-supporting' | 'endorsing' | 'signed-endorsing';

/** One token the policy asks for. */
export interface WssPolicyToken {
  readonly kind: 'username' | 'x509' | 'issued' | 'saml' | 'kerberos' | 'other';
  readonly role: WssPolicyTokenRole;
  /** Username tokens: how the password travels (`sp:HashPassword` → digest, `sp:NoPassword` → none). */
  readonly password?: 'text' | 'digest' | 'none';
  /** X.509 tokens: the key identifier form the policy requires. */
  readonly reference?: WssPolicyKeyReference;
  /** Issued tokens: the STS address from `sp:Issuer/wsa:Address`. */
  readonly issuer?: string;
  /** For `other`: the assertion's local name, so the summary can still name it. */
  readonly name?: string;
}

/** A message part the policy signs or encrypts: the SOAP `Body`, or a header by name and namespace. */
export interface WssPolicyPart {
  readonly name: string;
  readonly namespace: string;
}

/** One operation's effective security policy. */
export interface WssPolicy {
  /** `1.2` for WS-SecurityPolicy 1.2/1.3 (OASIS), `1.1` for the 2005/07 namespace. */
  readonly version: '1.1' | '1.2';
  /** The binding's SOAP version, which fixes the `Body`'s namespace. */
  readonly soapVersion: '1.1' | '1.2';
  readonly binding: 'transport' | 'asymmetric' | 'symmetric' | 'none';
  /** A transport binding with an `sp:HttpsToken`. */
  readonly requiresTls: boolean;
  readonly includeTimestamp: boolean;
  readonly encryptBeforeSigning: boolean;
  /** The `sp:AlgorithmSuite` choice by local name (`Basic256Sha256`, …). */
  readonly algorithmSuite?: string;
  readonly tokens: readonly WssPolicyToken[];
  readonly signedParts: readonly WssPolicyPart[];
  readonly encryptedParts: readonly WssPolicyPart[];
  /** Requirements a configuration cannot express; each one keeps the policy from being satisfied. */
  readonly unsupported: readonly string[];
  /** Informational notes (alternatives skipped, unresolved references). */
  readonly notes: readonly string[];
}
