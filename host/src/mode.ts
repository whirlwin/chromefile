export type Mode = "host" | "mcp" | "call";

export const USAGE = `Usage: cbb <mode>

Modes:
  host                          Native messaging host, started by Chrome
  mcp                           MCP server over stdio, started by Claude Code
  call <method> [json-params]   Send one request to the bridge and print the
                                result as JSON (exit 1 on error, 2 if the
                                browser is not connected)
`;

/**
 * Picks the mode from argv. Chrome appends the calling extension's origin
 * (and on Windows a window handle) after the host path, so only the first
 * argument is significant.
 */
export function parseMode(args: readonly string[]): Mode | undefined {
  const [first] = args;
  return first === "host" || first === "mcp" || first === "call" ? first : undefined;
}
