/** The single active 1:1 call (legacy Matrix VoIP), shared between the header button and the call UI. */
import { useSyncExternalStore } from "react";
import type { MatrixCall } from "matrix-js-sdk";

let active: MatrixCall | null = null;
const listeners = new Set<() => void>();

export function setActiveCall(call: MatrixCall | null): void {
  active = call;
  listeners.forEach((l) => l());
}

export function getActiveCall(): MatrixCall | null {
  return active;
}

export function useActiveCall(): MatrixCall | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => active,
    () => null,
  );
}
