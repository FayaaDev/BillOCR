export type LogLevel = "debug" | "info" | "warn" | "error";
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const sensitive = /(?:authorization|token|secret|password|api[_-]?key|credential|service.?account|auth)/i;

function redact(value: unknown, key?: string): unknown {
  if (key && sensitive.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  return value;
}

export interface Logger { debug(message: string, fields?: Record<string, unknown>): void; info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void; error(message: string, fields?: Record<string, unknown>): void; }

export function createLogger(minimum: LogLevel = "info", write: (line: string) => void = console.log): Logger {
  const log = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (order[level] < order[minimum]) return;
    write(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...(redact(fields) as Record<string, unknown>) }));
  };
  return { debug: (m, f) => log("debug", m, f), info: (m, f) => log("info", m, f), warn: (m, f) => log("warn", m, f), error: (m, f) => log("error", m, f) };
}
