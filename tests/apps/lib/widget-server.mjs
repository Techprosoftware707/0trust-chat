/**
 * Static file server for the call widget bundle (services/chat/dist-widget), standing in
 * for Android's WebViewAssetLoader / iOS's WKURLSchemeHandler: it serves the bundled files
 * as they are, with a content type and nothing else — in particular no Content-Security-
 * Policy header, because the apps' asset loaders don't add one either, so the widget's own
 * <meta> CSP is what protects it there (and what this test exercises).
 *
 * Served on http://localhost:<port>, a secure context (camera/microphone are allowed).
 *
 *   node tests/apps/lib/widget-server.mjs <dir> <port>
 *   (run inside the browser's network namespace: `ip netns exec lab-a node …`)
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
};

export function startWidgetServer(dir, port = 0, host = "127.0.0.1") {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Content-Length": statSync(file).size,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, port] = process.argv.slice(2);
  if (!dir || !port) {
    console.error("usage: node widget-server.mjs <dir> <port>");
    process.exit(64);
  }
  const server = await startWidgetServer(dir, Number(port));
  console.log(`widget server listening on http://localhost:${server.address().port}/ (${dir})`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
