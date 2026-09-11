/**
 * Incoming WS-Security processing: what a configured response goes through after it has been
 * read off the wire (and after MTOM expansion, so the envelope is the one the user will see).
 *
 * The result is deliberately a *report*, not a verdict. Nothing here throws and nothing here
 * refuses a response: a failed signature, an untrusted signer and an expired timestamp are all
 * recorded as failed actions and shown, because a workbench's job is to tell you exactly what
 * the server sent, not to hide it. The caller decides what to make of that.
 */

import { isWirebenchError } from '../../errors.js';
import { selectAlias } from '../keystore/index.js';
import { decryptIncoming } from './decrypt.js';
import { verifyIncoming } from './verify.js';
import type { WssContext, WssIncomingConfig } from '../model.js';

/** Which of the three incoming steps an action reports on. */
export type WssActionKind = 'decrypt' | 'signature' | 'timestamp';

/** One step of incoming processing, as the response inspector lists it. */
export interface WssAction {
  readonly kind: WssActionKind;
  readonly ok: boolean;
  /** A human-readable summary. Never carries key material, a password or a secret reference. */
  readonly detail: string;
  /** The signer's subject DN; only on a `signature` action whose certificate resolved. */
  readonly signerSubject?: string;
  /** Whether the signer is in (or chains to) the truststore; only on a `signature` action. */
  readonly trusted?: boolean;
  /** `wsu:Created`; only on a `timestamp` action. */
  readonly created?: string;
  /** `wsu:Expires`; only on a `timestamp` action that had one. */
  readonly expires?: string;
}

/** What {@link processIncomingWss} made of a response. */
export interface WssResult {
  /** One entry per step actually taken, in processing order. Empty for an unsecured response. */
  readonly actions: readonly WssAction[];
  /** The restored envelope, present only when decryption actually changed something. */
  readonly decryptedXml?: string;
  /** Every failure, as a message safe to log. Empty when every action succeeded. */
  readonly errors: readonly string[];
}

/** Options for {@link processIncomingWss}. */
export interface ProcessIncomingWssOptions {
  /** The clock timestamp freshness (and certificate validity) is judged against. */
  readonly clock?: () => Date;
}

/** The message of a thrown value, without the stack or any `details` a secret could hide in. */
function messageOf(error: unknown): string {
  if (isWirebenchError(error)) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The decrypt step: the (possibly restored) XML plus the action it produced, if any. */
async function runDecrypt(
  xml: string,
  config: WssIncomingConfig,
  ctx: WssContext,
): Promise<{ xml: string; decryptedXml?: string; action?: WssAction }> {
  const ref = config.decryptKeystoreRef;
  if (ref === undefined || ref === '') {
    return { xml };
  }
  const keystore = await ctx.keystores(ref);
  if (keystore === undefined) {
    return {
      xml,
      action: { kind: 'decrypt', ok: false, detail: 'The decryption keystore is not available.' },
    };
  }
  try {
    const alias = selectAlias(keystore, config.decryptAlias);
    const password =
      config.decryptKeyPasswordRef === undefined ? undefined : await ctx.secrets(config.decryptKeyPasswordRef);
    const result = decryptIncoming(xml, {
      keystore,
      alias,
      ...(password !== undefined ? { keyPassword: password } : {}),
    });
    if (result.decrypted.length === 0) {
      // Nothing was encrypted: not a step that happened, so not a step to report.
      return { xml: result.xml };
    }
    return {
      xml: result.xml,
      decryptedXml: result.xml,
      action: {
        kind: 'decrypt',
        ok: true,
        detail:
          result.decrypted.length === 1 ? 'Decrypted 1 block.' : `Decrypted ${String(result.decrypted.length)} blocks.`,
      },
    };
  } catch (error) {
    return { xml, action: { kind: 'decrypt', ok: false, detail: messageOf(error) } };
  }
}

/**
 * Runs `config` over a response envelope: decrypt, then verify every signature on the restored
 * document, then judge the timestamp.
 *
 * @param xml the response envelope as it arrived
 * @param config the incoming configuration the request selected
 * @param ctx the injected keystore/secret capabilities
 * @param options an injected clock, so freshness is testable
 * @returns the actions taken, the decrypted envelope when there was one, and any failures
 */
export async function processIncomingWss(
  xml: string,
  config: WssIncomingConfig,
  ctx: WssContext,
  options?: ProcessIncomingWssOptions,
): Promise<WssResult> {
  const clock = options?.clock ?? ctx.clock;
  const actions: WssAction[] = [];
  const errors: string[] = [];

  const decrypt = await runDecrypt(xml, config, ctx);
  if (decrypt.action !== undefined) {
    actions.push(decrypt.action);
    if (!decrypt.action.ok) {
      errors.push(decrypt.action.detail);
      // Whatever the signatures cover is still ciphertext, so verifying them would report a
      // failure whose real cause is the key, not the signature. Say so instead.
      actions.push({
        kind: 'signature',
        ok: false,
        detail: 'Signatures were not verified because the message could not be decrypted.',
      });
      return { actions, errors };
    }
  }

  const truststore =
    config.signatureKeystoreRef === undefined || config.signatureKeystoreRef === ''
      ? undefined
      : await ctx.keystores(config.signatureKeystoreRef);
  if (config.signatureKeystoreRef !== undefined && config.signatureKeystoreRef !== '' && truststore === undefined) {
    errors.push('The signature truststore is not available.');
  }

  const verified = verifyIncoming(decrypt.xml, {
    ...(truststore !== undefined ? { truststore } : {}),
    clock,
    skewSeconds: config.timestampSkewSeconds,
    verifyChain: config.verifyChain,
  });

  for (const signature of verified.signatures) {
    const ok = signature.ok && signature.trusted;
    const detail = signature.ok
      ? signature.trusted
        ? `Signature valid over ${String(signature.references.length)} reference(s); signer trusted.`
        : `Signature valid over ${String(signature.references.length)} reference(s), but the signer is not trusted.`
      : (signature.error ?? 'The signature did not verify.');
    actions.push({
      kind: 'signature',
      ok,
      detail,
      ...(signature.signerSubject !== undefined ? { signerSubject: signature.signerSubject } : {}),
      trusted: signature.trusted,
    });
    if (!ok) {
      errors.push(detail);
    }
  }
  if (verified.signatures.length === 0 && config.requireSignature) {
    const detail = 'This response carries no signature, and one is required.';
    actions.push({ kind: 'signature', ok: false, detail });
    errors.push(detail);
  }

  const timestamp = verified.timestamp;
  if (timestamp !== undefined) {
    const detail = timestamp.fresh
      ? `Timestamp fresh (created ${timestamp.created}).`
      : (timestamp.error ?? 'The timestamp is not fresh.');
    actions.push({
      kind: 'timestamp',
      ok: timestamp.fresh,
      detail,
      created: timestamp.created,
      ...(timestamp.expires !== undefined ? { expires: timestamp.expires } : {}),
    });
    if (!timestamp.fresh) {
      errors.push(detail);
    }
  } else if (config.requireTimestamp) {
    const detail = 'This response carries no timestamp, and one is required.';
    actions.push({ kind: 'timestamp', ok: false, detail });
    errors.push(detail);
  }

  return {
    actions,
    ...(decrypt.decryptedXml !== undefined ? { decryptedXml: decrypt.decryptedXml } : {}),
    errors,
  };
}
