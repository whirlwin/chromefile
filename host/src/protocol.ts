// Message shapes shared by all three hops. See docs/architecture.md.

export type RequestId = string | number;

export type ErrorCode =
  | "not_connected"
  | "too_large"
  | "bad_request"
  | "not_found"
  | "unavailable"
  | "disabled"
  | "internal"
  | "timeout";

export interface BridgeError {
  code: ErrorCode | string;
  message: string;
}

export interface Request {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface Response {
  id: RequestId | null;
  result?: unknown;
  error?: BridgeError;
}

export function errorResponse(id: RequestId | null, code: ErrorCode, message: string): Response {
  return { id, error: { code, message } };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
