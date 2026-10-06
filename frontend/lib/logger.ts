type LogContext = Record<string, string | number | boolean | null | undefined>;

function writeLog(
  level: "info" | "warn" | "error",
  event: string,
  context: LogContext = {},
) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    context,
  };
  const output = JSON.stringify(entry);

  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.info(output);
}

export const logInfo = (event: string, context?: LogContext) =>
  writeLog("info", event, context);

export const logWarning = (event: string, context?: LogContext) =>
  writeLog("warn", event, context);

export function logError(event: string, error?: Error, context: LogContext = {}) {
  writeLog("error", event, {
    ...context,
    errorName: error?.name,
  });
}
