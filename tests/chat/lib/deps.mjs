/** Resolve npm dependencies from services/chat/node_modules (tests live outside that package). */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../../services/chat/package.json", import.meta.url));

export function resolveChatDep(spec) {
  return require.resolve(spec);
}

export async function importChatDep(spec) {
  return import(pathToFileURL(require.resolve(spec)).href);
}
