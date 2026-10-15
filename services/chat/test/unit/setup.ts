import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

// jsdom doesn't implement SubtleCrypto; use Node's WebCrypto (same API as browsers).
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
