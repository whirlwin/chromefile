// Small validators for request params. Each throws bad_request on a mismatch.
import { BridgeError } from "./protocol";
import type { Params } from "./protocol";

function bad(message: string): never {
  throw new BridgeError("bad_request", message);
}

export function str(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") bad(`${key} must be a non-empty string`);
  return value;
}

export function optStr(params: Params, key: string): string | undefined {
  return params[key] === undefined ? undefined : str(params, key);
}

export function optNum(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) bad(`${key} must be an integer`);
  return value;
}

export function optBool(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") bad(`${key} must be a boolean`);
  return value;
}

export function numList(params: Params, key: string): number[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => Number.isInteger(v))) {
    bad(`${key} must be a non-empty array of integers`);
  }
  return value as number[];
}

export function strList(params: Params, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    bad(`${key} must be a non-empty array of strings`);
  }
  return value as string[];
}

export function objList(params: Params, key: string): Record<string, unknown>[] {
  const value = params[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))) {
    bad(`${key} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

export function oneOf<T extends string>(params: Params, key: string, allowed: readonly T[]): T | undefined {
  const value = optStr(params, key);
  if (value !== undefined && !(allowed as readonly string[]).includes(value)) {
    bad(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T | undefined;
}
