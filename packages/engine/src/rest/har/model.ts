/**
 * HAR 1.1 and 1.2 representation: the parts of a browser capture the REST import reads.
 *
 * Browser-safe: format detection runs in the renderer, so nothing here may import Node.
 */

export interface HarNameValue {
  readonly name: string;
  readonly value: string;
}

export interface HarPostData {
  readonly mimeType: string;
  readonly text?: string;
  readonly params?: readonly {
    readonly name: string;
    readonly value?: string;
    readonly fileName?: string;
    readonly contentType?: string;
  }[];
}

export interface HarEntryIn {
  readonly startedDateTime: string;
  readonly time: number;
  /** The browser's `_resourceType` (`xhr`, `fetch`, `script`, …), when it records one. */
  readonly resourceType?: string;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: readonly HarNameValue[];
    readonly queryString: readonly HarNameValue[];
    readonly postData?: HarPostData;
  };
  readonly response: {
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly HarNameValue[];
    readonly content: { readonly mimeType: string; readonly text?: string; readonly encoding?: string };
  };
}

export interface HarLogIn {
  readonly version: string;
  readonly entries: readonly HarEntryIn[];
  /** Entries dropped for lacking a request method or URL. */
  readonly skippedMalformed: number;
}

/** The largest HAR file the importer reads. */
export const MAX_HAR_INPUT_BYTES = 100 * 1024 * 1024;
