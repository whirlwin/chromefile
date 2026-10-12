import { describe, expect, it } from "vitest";
import { appendLog } from "../src/commandLog";
import type { LogEntry } from "../src/commandLog";

describe("appendLog", () => {
  it("keeps the newest entries up to the limit", () => {
    let log: LogEntry[] = [];
    for (let i = 0; i < 5; i++) log = appendLog(log, { time: String(i), method: "m", ok: true }, 3);
    expect(log.map((e) => e.time)).toEqual(["2", "3", "4"]);
  });
});
