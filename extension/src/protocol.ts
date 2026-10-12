// Message shapes shared by every hop (docs/architecture.md, "Messages").

export type ErrorCode =
  | "not_connected"
  | "too_large"
  | "bad_request"
  | "not_found"
  | "unavailable"
  | "disabled"
  | "internal";

export interface Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type Response =
  | { id: string; result: unknown }
  | { id: string; error: { code: ErrorCode; message: string } };

export type Params = Record<string, unknown>;
export type Handler = (params: Params) => Promise<unknown>;
export type HandlerMap = Record<string, Handler>;

// Thrown by handlers to choose the error code; anything else becomes `internal`
// (or `not_found` when Chrome's message says so).
export class BridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
