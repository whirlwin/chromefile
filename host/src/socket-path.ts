import { chmodSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const APP_DIR = "claude-browser-bridge";
const SOCKET_NAME = "bridge.sock";

/** Where the host listens and the MCP server connects. */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CBB_SOCKET) return env.CBB_SOCKET;
  return join(defaultSocketDir(env), SOCKET_NAME);
}

function defaultSocketDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR);
  }
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, APP_DIR);
  return join(homedir(), ".local", "state", APP_DIR);
}

/**
 * Creates the socket's directory with mode 0700. The default directory is
 * ours alone, so looser permissions on it are tightened. A directory picked
 * through CBB_SOCKET may be shared (say /tmp), so it is created if missing
 * but never chmod'ed.
 */
export function ensureSocketDir(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (env.CBB_SOCKET) return;
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
