// stdout is a protocol channel in both modes (native messaging framing or
// MCP over stdio). Everything human-readable must go to stderr.
import { runCall } from "./call";
import { runHost } from "./host";
import { runMcp } from "./mcp";
import { USAGE, parseMode } from "./mode";

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  switch (mode) {
    case "host":
      runHost();
      return;
    case "mcp":
      runMcp().catch((error: unknown) => {
        process.stderr.write(`cbb mcp: ${(error as Error).message}\n`);
        process.exitCode = 1;
      });
      return;
    case "call":
      runCall(process.argv.slice(3)).then(
        (code) => (process.exitCode = code),
        (error: unknown) => {
          process.stderr.write(`cbb call: ${(error as Error).message}\n`);
          process.exitCode = 1;
        },
      );
      return;
    case undefined:
      process.stderr.write(USAGE);
      process.exitCode = 2;
      return;
  }
}

main();
