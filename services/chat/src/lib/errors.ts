/** User-facing error messages (never includes tokens or message contents). */
import { ConnectionError, MatrixError } from "matrix-js-sdk";

export function errorMessage(e: unknown, fallback = "Something went wrong."): string {
  if (e instanceof MatrixError) {
    switch (e.errcode) {
      case "M_FORBIDDEN":
        return e.data?.error ? String(e.data.error) : "You don't have permission to do that.";
      case "M_LIMIT_EXCEEDED":
        return "You're doing that too often. Please wait a moment and try again.";
      case "M_TOO_LARGE":
        return "That file is too large for the server.";
      case "M_NOT_FOUND":
        return e.data?.error ? String(e.data.error) : "Not found.";
      case "M_UNKNOWN_TOKEN":
        return "Your session has ended. Please sign in again.";
      default:
        return e.data?.error ? String(e.data.error) : e.message || fallback;
    }
  }
  if (e instanceof ConnectionError || (e instanceof TypeError && /fetch|network/i.test(e.message))) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (e instanceof DOMException && e.name === "AbortError") return "Cancelled.";
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
