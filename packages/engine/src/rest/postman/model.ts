/**
 * Postman Collection v2.0 and v2.1 representation and intermediate types.
 *
 * Postman collections are JSON documents containing nested items: items with child `item` arrays
 * represent folders, and items with a `request` object represent executable HTTP requests.
 */

import type { AuthConfig } from '../../project/model.js';

export interface PostmanInfo {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly schema?: string;
  readonly _postman_id?: string;
}

export interface PostmanVariable {
  readonly key: string;
  readonly value?: string | number | boolean | null;
  readonly type?: string;
  readonly description?: string;
}

export interface PostmanAuthAttribute {
  readonly key: string;
  readonly value: unknown;
  readonly type?: string;
}

export interface PostmanAuth {
  readonly type?: string;
  readonly basic?: readonly PostmanAuthAttribute[];
  readonly bearer?: readonly PostmanAuthAttribute[];
  readonly apikey?: readonly PostmanAuthAttribute[];
  readonly oauth2?: readonly PostmanAuthAttribute[];
  readonly ntlm?: readonly PostmanAuthAttribute[];
  readonly noauth?: unknown;
}

export interface PostmanQueryParam {
  readonly key?: string;
  readonly value?: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface PostmanUrl {
  readonly raw?: string;
  readonly protocol?: string;
  readonly host?: readonly string[] | string;
  readonly path?: readonly string[] | string;
  readonly port?: string;
  readonly query?: readonly PostmanQueryParam[];
  readonly variable?: readonly PostmanVariable[];
}

export interface PostmanHeader {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface PostmanUrlEncodedParam {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface PostmanFormDataParam {
  readonly key: string;
  readonly value?: string;
  readonly src?: string | readonly string[];
  readonly type?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly contentType?: string;
}

export interface PostmanBody {
  readonly mode?: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql' | (string & {});
  readonly raw?: string;
  readonly options?: {
    readonly raw?: {
      readonly language?: 'json' | 'xml' | 'text' | 'html' | 'javascript' | (string & {});
    };
  };
  readonly urlencoded?: readonly PostmanUrlEncodedParam[];
  readonly formdata?: readonly PostmanFormDataParam[];
  readonly file?: { readonly src?: string; readonly content?: string };
}

export interface PostmanRequest {
  readonly method?: string;
  readonly url?: PostmanUrl | string;
  readonly header?: readonly PostmanHeader[] | string;
  readonly body?: PostmanBody;
  readonly auth?: PostmanAuth;
  readonly description?: string;
}

export interface PostmanItem {
  readonly name: string;
  readonly description?: string;
  readonly item?: readonly PostmanItem[];
  readonly request?: PostmanRequest | string;
  readonly auth?: PostmanAuth;
  readonly variable?: readonly PostmanVariable[];
}

export interface PostmanCollection {
  readonly info: PostmanInfo;
  readonly item: readonly PostmanItem[];
  readonly auth?: PostmanAuth;
  readonly variable?: readonly PostmanVariable[];
  /** Problems found while parsing that the import summary should report. */
  readonly warnings?: readonly string[];
}

/** Summary of what the Postman import produced, for the import summary display. */
export interface PostmanImportSummary {
  readonly name: string;
  readonly description?: string;
  readonly folders: number;
  readonly requests: number;
  readonly auth?: AuthConfig['type'];
  readonly warnings?: readonly string[];
}
