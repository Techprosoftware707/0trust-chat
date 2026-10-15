/**
 * Maps app:// request URLs to files inside the app bundle, refusing anything that could
 * escape the served directory (traversal, encoded separators, NUL, drive letters, UNC).
 * Pure: uses only node:path.
 */
import path from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export function mimeFor(file: string): string | null {
  return MIME[path.extname(file).toLowerCase()] ?? null;
}

/**
 * Resolves the pathname of an app:// URL (as given by `new URL(req.url).pathname`, still
 * percent-encoded) to an absolute file path under `root`, or null if it is not allowed.
 * "/" maps to `index`.
 */
export function resolveAppPath(root: string, pathname: string, index = "index.html"): string | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.length > 1024) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // No NUL, no backslashes (Windows separators), no encoded slashes smuggled in, no drive letters / UNC.
  if (decoded.includes("\0") || decoded.includes("\\") || /%2f|%5c/i.test(pathname)) return null;
  if (/^\/[A-Za-z]:/.test(decoded) || decoded.startsWith("//")) return null;
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "." || s === ".." || s.startsWith(".") || /[<>:"|?*]/.test(s))) return null;
  const rel = segments.length === 0 ? index : segments.join("/");
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, rel);
  const relative = path.relative(resolvedRoot, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (!mimeFor(file)) return null;
  return file;
}
