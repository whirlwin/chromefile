import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appDir, socketPath } from "./socket-path";

describe("socketPath and appDir", () => {
  it("default to the shared chromefile directory", () => {
    if (process.platform !== "darwin") return;
    const dir = join(homedir(), "Library", "Application Support", "chromefile");
    expect(socketPath({})).toBe(join(dir, "chromefile.sock"));
    expect(appDir({})).toBe(dir);
  });

  it("follow CHROMEFILE_HOME", () => {
    expect(socketPath({ CHROMEFILE_HOME: "/x/home" })).toBe("/x/home/chromefile.sock");
    expect(appDir({ CHROMEFILE_HOME: "/x/home" })).toBe("/x/home");
  });

  it("put the socket at CHROMEFILE_SOCKET and keep config next to it", () => {
    expect(socketPath({ CHROMEFILE_SOCKET: "/s/a.sock" })).toBe("/s/a.sock");
    expect(appDir({ CHROMEFILE_SOCKET: "/s/a.sock" })).toBe("/s");
    expect(appDir({ CHROMEFILE_SOCKET: "/s/a.sock", CHROMEFILE_HOME: "/x/home" })).toBe("/x/home");
  });
});
