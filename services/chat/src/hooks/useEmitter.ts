import { useEffect, useReducer, useRef } from "react";

interface Emitter {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * Re-renders the component whenever `emitter` emits one of `events`.
 * Bursts are coalesced (at most one render per `throttleMs`).
 * Returns a counter that changes on every emitted batch (use it as a memo dependency).
 */
export function useEmitterVersion(emitter: Emitter | null | undefined, events: readonly string[], throttleMs = 0): number {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const key = events.join("|");
  useEffect(() => {
    if (!emitter) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (throttleMs <= 0) return bump();
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        bump();
      }, throttleMs);
    };
    const names = key.split("|");
    for (const e of names) emitter.on(e, handler);
    return () => {
      for (const e of names) emitter.off(e, handler);
      if (timer) clearTimeout(timer);
    };
  }, [emitter, key, throttleMs]);
  return version;
}

/** Subscribes `handler` (always the latest closure) to `event` on `emitter`. */
export function useEmitterEvent<A extends unknown[]>(
  emitter: Emitter | null | undefined,
  event: string,
  handler: (...args: A) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!emitter) return;
    const h = (...args: A) => ref.current(...args);
    emitter.on(event, h as never);
    return () => {
      emitter.off(event, h as never);
    };
  }, [emitter, event]);
}
