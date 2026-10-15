/**
 * Static server for the built chat app with the production security headers
 * (same CSP as deploy/lib/render.py), a generated /config.json, /brand/* from
 * branding/, and a reverse proxy for /_matrix and /_synapse to the dev
 * homeserver (so the homeserver is same-origin and allowed by `connect-src`).
 *
 *   node tests/chat/lib/serve.mjs [port]
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
  "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; " +
  "connect-src 'self' https: wss:; worker-src 'self' blob:; frame-src 'none'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

function sendFile(res, file, extraHeaders = {}) {
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": statSync(file).size, ...extraHeaders });
  createReadStream(file).pipe(res);
}

export function startServer({ port = 0, distDir = path.join(REPO, "services/chat/dist"), upstream = "http://127.0.0.1:28008", config } = {}) {
  const up = new URL(upstream);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith("/_matrix/") || p.startsWith("/_synapse/")) {
      const proxied = http.request(
        { host: up.hostname, port: up.port, path: req.url, method: req.method, headers: { ...req.headers, host: up.host } },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      proxied.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(proxied);
      return;
    }
    const security = {
      "Content-Security-Policy": CSP,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    if (p === "/config.json") {
      const origin = `http://${req.headers.host}`;
      const body = JSON.stringify(
        typeof config === "function" ? config(origin) : config ?? defaultConfig(origin),
      );
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...security });
      res.end(body);
      return;
    }
    if (p.startsWith("/brand/")) {
      const file = path.normalize(path.join(REPO, "branding", p.slice(7)));
      if (file.startsWith(path.join(REPO, "branding") + path.sep) && existsSync(file)) return sendFile(res, file, security);
      res.writeHead(404, security);
      res.end();
      return;
    }
    let file = path.normalize(path.join(distDir, p));
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(distDir, "index.html");
    sendFile(res, file, security);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** Production-shaped config whose default homeserver is unreachable SSO, forcing the "other server" path. */
export function defaultConfig() {
  return {
    brand: { name: "Lumen Secure", short_name: "Lumen" },
    homeserver: { base_url: "https://matrix.lumen-test.invalid", server_name: "chatdev.test" },
    sso: { idp_id: "oidc-lumen", label: "Continue with your Lumen account" },
    portal_url: "https://lumen.test",
    allow_custom_homeserver: true,
    voip_enabled: false,
    privacy_url: "https://lumen.test/privacy/",
    help_url: "https://lumen.test/docs/",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer({ port: Number(process.argv[2] || 28080) });
  console.log(`serving dist on ${origin}`);
}
