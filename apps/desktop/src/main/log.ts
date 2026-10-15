/**
 * Main-process log: console plus <userData>/logs/main.log (rotated at 1 MB, one old file).
 * Never logs tokens, keys, PINs, message content or room names; URL query values that can
 * carry secrets are masked as a second line of defence.
 */
import fs from "node:fs";
import path from "node:path";

let file: string | null = null;

const SECRET_PARAMS = /([?&](?:loginToken|access_token|n|token|code|state)=)[^&#\s"']+/gi;

export function redact(s: string): string {
  return s.replace(SECRET_PARAMS, "$1[redacted]").replace(/\b(syt|syl|syr)_[A-Za-z0-9._~+/=-]+/g, "$1_[redacted]");
}

export function initLog(userData: string): void {
  try {
    const dir = path.join(userData, "logs");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, "main.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, path.join(dir, "main.old.log"));
  } catch {
    file = null;
  }
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${redact(msg)}`;
  if (level === "ERROR" || level === "WARN") console.error(`[lumen] ${line}`);
  else console.log(`[lumen] ${line}`);
  if (file) {
    try {
      fs.appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch {
      /* disk full or read-only: console only */
    }
  }
}

export const log = {
  info: (m: string) => write("INFO", m),
  warn: (m: string) => write("WARN", m),
  error: (m: string, e?: unknown) => write("ERROR", e instanceof Error ? `${m}: ${e.name}: ${e.message}` : m),
};
