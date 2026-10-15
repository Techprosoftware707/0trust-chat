/**
 * One running client per browser profile. Two MatrixClients sharing the same
 * Rust crypto store (IndexedDB) would corrupt it, so the app holds a Web Lock
 * for as long as it runs; a second tab waits until the first one is closed.
 */
const LOCK_NAME = "lumen-chat-session";
let held = false;

export async function acquireTabLock(): Promise<boolean> {
  // A reload briefly overlaps with the previous document releasing its lock: retry a few times.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await tryAcquire()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function tryAcquire(): Promise<boolean> {
  if (held) return true;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return true; // very old browser: no guard available
  return new Promise<boolean>((resolve) => {
    void locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        held = true;
        resolve(true);
        // Hold the lock until the page goes away.
        return new Promise<void>(() => undefined);
      })
      .catch(() => resolve(true));
  });
}
