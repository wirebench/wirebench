/**
 * Shared types for the MIME layer: what goes into a `multipart/related` body,
 * what comes back out of one, and how an {@link Attachment}'s bytes are obtained.
 *
 * The engine never reads an attachment from disk on its own: the send path is
 * handed an {@link AttachmentResolver} so the desktop main process (which owns the
 * project directory and its cache) decides where bytes come from. See
 * `project/attachments-cache.ts` for the file-backed implementation.
 */

import type { Attachment } from '../../project/model.js';

/** Resolves one attachment's bytes. Rejects when the attachment cannot be read. */
export type AttachmentResolver = (attachment: Attachment) => Promise<Uint8Array>;

/** Content transfer encodings this layer writes or understands. */
export type TransferEncoding = 'binary' | 'base64' | '8bit' | '7bit' | 'quoted-printable';

/**
 * Transfer encodings {@link buildMultipartRelated} can actually produce: `quoted-printable`
 * is understood on parse but this layer never writes it, so it is left out of the build-side
 * type rather than silently passed through as if it were `binary`.
 */
export type BuildTransferEncoding = 'binary' | 'base64' | '8bit' | '7bit';

/** One part to write into a `multipart/related` body. */
export interface MultipartPart {
  /** Content-ID without the angle brackets; they are added on the wire. */
  readonly contentId: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Defaults to `binary`; `base64` re-encodes the bytes and wraps at 76 columns. */
  readonly transferEncoding?: BuildTransferEncoding;
  /** File name for `Content-Disposition: attachment; filename="..."`. */
  readonly fileName?: string;
  /** WSDL `mime:part` name for `Content-Disposition: attachment; name="..."`. */
  readonly partName?: string;
}

/** The root (SOAP envelope) part of a `multipart/related` body. */
export interface MultipartRoot {
  readonly contentType: string;
  /** Content-ID without the angle brackets; defaults to `rootpart@wirebench`. */
  readonly contentId?: string;
  readonly bytes: Uint8Array;
}

/** One part read back out of a `multipart/related` body. */
export interface MimePart {
  /** Header names lower-cased, values unfolded and trimmed; duplicates keep the first. */
  readonly headers: Readonly<Record<string, string>>;
  /** Content-ID with the angle brackets stripped, when the part carried one. */
  readonly contentId?: string;
  /** `application/octet-stream` when the part declared no `Content-Type`. */
  readonly contentType: string;
  readonly transferEncoding?: TransferEncoding;
  /** Part body, decoded when the transfer encoding was `base64`/`quoted-printable`. */
  readonly bytes: Uint8Array;
  /** Part body exactly as it appeared on the wire, still encoded. */
  readonly raw: Uint8Array;
  /** `filename` from `Content-Disposition`, or the last segment of `Content-Location`. */
  readonly fileName?: string;
  /** `name` from `Content-Disposition`. */
  readonly partName?: string;
}

/** One attachment received on a response. */
export interface ResponseAttachment {
  /** Content-ID without the angle brackets; empty when the part carried none. */
  readonly contentId: string;
  readonly contentType: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  /** File name, when the part declared one. */
  readonly name?: string;
  readonly transferEncoding?: TransferEncoding;
}
