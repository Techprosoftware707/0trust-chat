import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
// The Docker build copies design/ and branding/ next to services/ exactly as in
// the repository, so these relative paths work both locally and in the image.
const repoRoot = path.resolve(here, "../..");
const designDir = path.join(repoRoot, "design");
const brandingDir = path.join(repoRoot, "branding");
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")) as { version: string };

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

/**
 * Development-only middleware: serve /brand/* from branding/ (in production
 * Caddy serves the operator's branding directory there) and /config.json from
 * dev/config.json (in production the installer renders it).
 */
function devAssets(): Plugin {
  return {
    name: "lumen-dev-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0];
        let file: string | null = null;
        if (url === "/config.json") file = path.join(here, "dev", "config.json");
        else if (url.startsWith("/brand/")) {
          const candidate = path.normalize(path.join(brandingDir, url.slice("/brand/".length)));
          if (candidate.startsWith(brandingDir + path.sep)) file = candidate;
        }
        if (!file) return next();
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devAssets()],
  resolve: {
    alias: {
      "@design": designDir,
      "@branding": brandingDir,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [here, designDir, brandingDir] },
  },
  preview: { host: "127.0.0.1", port: 4173 },
  optimizeDeps: {
    // The crypto WASM is located with `new URL(..., import.meta.url)`; pre-bundling breaks that.
    exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // Never inline assets as data: URIs; everything is a hashed file under /assets/.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
  },
});
