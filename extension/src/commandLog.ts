export interface LogEntry {
  time: string; // ISO 8601
  method: string;
  ok: boolean;
}

// Appends to a ring buffer, keeping the newest `limit` entries.
export function appendLog(log: readonly LogEntry[], entry: LogEntry, limit: number): LogEntry[] {
  return [...log, entry].slice(-limit);
}
