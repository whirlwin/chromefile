// `cbb call <method> [json-params]`: one request over the socket, for scripts
// (scripts/chrome-apply.sh). Exit codes: 0 result printed to stdout, 1 the
// bridge answered with an error, 2 not connected or bad usage.
import { BridgeClient } from "./bridge-client";
import { isObject } from "./protocol";
import { socketPath } from "./socket-path";

const TIMEOUT_MS = 30_000;

export async function runCall(args: readonly string[]): Promise<number> {
  const [method, rawParams] = args;
  if (!method) {
    process.stderr.write("Usage: cbb call <method> [json-params]\n");
    return 2;
  }
  let params: unknown = {};
  if (rawParams !== undefined) {
    try {
      params = JSON.parse(rawParams);
    } catch {
      process.stderr.write("bad_request: params must be valid JSON\n");
      return 1;
    }
    if (!isObject(params)) {
      process.stderr.write("bad_request: params must be a JSON object\n");
      return 1;
    }
  }
  const client = new BridgeClient(socketPath());
  try {
    const response = await client.request(method, params, TIMEOUT_MS);
    if (response.error) {
      process.stderr.write(`${response.error.code}: ${response.error.message}\n`);
      return response.error.code === "not_connected" ? 2 : 1;
    }
    // Written without process.exit(): stdout to a pipe is asynchronous on
    // macOS, and a large result (mods.list carries every mod's code) would be
    // cut short.
    process.stdout.write(`${JSON.stringify(response.result ?? {})}\n`);
    return 0;
  } finally {
    client.close();
  }
}
