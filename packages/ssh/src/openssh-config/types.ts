/** One `keyword args…` line of an OpenSSH client config, after lexing. */
export interface SshConfigLine {
  /** The file as shown to the user (`~/.ssh/config`), not necessarily its absolute path. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** Lower-cased. */
  readonly keyword: string;
  readonly args: readonly string[];
}

/** A line or file that could not be used. Never carries the line's text: it may hold a credential. */
export interface SshConfigProblem {
  readonly file: string;
  readonly line?: number;
  readonly why: string;
}
