/** Options accepted by the {@link WirebenchError} constructor and its subclasses. */
export interface WirebenchErrorOptions {
  /** Structured, machine-readable context for the error (never secrets). */
  readonly details?: Readonly<Record<string, unknown>>;
  /** The underlying error that caused this one, if any. */
  readonly cause?: unknown;
}

/**
 * Base class for every error the engine throws. Every Wirebench error carries
 * a stable, machine-readable `code` in addition to a human-readable message,
 * so callers (CLI, IPC, UI) can branch on `code` without parsing text.
 */
export class WirebenchError extends Error {
  /** Stable, machine-readable identifier for this error condition. */
  readonly code: string;
  /** Structured context for the error, if any. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WirebenchError';
    this.code = code;
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/** Thrown when a WSDL document cannot be parsed or is structurally invalid. */
export class WsdlParseError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'WsdlParseError';
  }
}

/** Thrown for XML Schema (XSD) validation or resolution failures. */
export class SchemaError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'SchemaError';
  }
}

/** Thrown for HTTP transport failures (network, status, timeout). */
export class HttpError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'HttpError';
  }
}

/** Thrown for WS-Security signing/encryption/verification failures. */
export class WssError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'WssError';
  }
}

/** Thrown for WS-Addressing header construction failures. */
export class WsaError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'WsaError';
  }
}

/** Thrown for project file (load/save/migration) failures. */
export class ProjectError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'ProjectError';
  }
}

/** Thrown for workspace file (load/save/migration) failures. */
export class WorkspaceError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'WorkspaceError';
  }
}

/** Thrown when an OpenAPI document cannot be read, or describes something this client cannot import. */
export class OpenApiError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'OpenApiError';
  }
}

/** Thrown when a Postman collection cannot be read, or is structurally invalid. */
export class PostmanError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'PostmanError';
  }
}

/** Thrown when a legacy single-XML SOAP project file cannot be read, or is not one. */
export class LegacyProjectError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'LegacyProjectError';
  }
}

/** Thrown when a `.proto` set cannot be parsed, an import cannot be found, or a name does not resolve. */
export class ProtoError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'ProtoError';
  }
}

/** Thrown for gRPC transport failures: the connection, the HTTP/2 stream, or a malformed frame. */
export class GrpcError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'GrpcError';
  }
}

/** Thrown when a value fails validation against a schema or business rule. */
export class ValidationError extends WirebenchError {
  constructor(code: string, message: string, options?: WirebenchErrorOptions) {
    super(code, message, options);
    this.name = 'ValidationError';
  }
}

/** Type guard identifying any {@link WirebenchError} (base class or subclass). */
export function isWirebenchError(e: unknown): e is WirebenchError {
  return e instanceof WirebenchError;
}
