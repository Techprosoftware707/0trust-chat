/**
 * Quietens matrix-js-sdk logging (which also carries the Rust crypto logs).
 * Production builds only print errors; the app itself never logs message
 * contents, keys, tokens or recovery keys.
 */
import loglevel from "loglevel";
import { logger as sdkLogger } from "matrix-js-sdk/lib/logger.js";

type Level = "trace" | "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Level[] = ["trace", "debug", "info", "warn", "error", "silent"];

export function configureSdkLogging(level: Level): void {
  const threshold = ORDER.indexOf(level);
  const factory: loglevel.MethodFactory = (methodName) => {
    const idx = ORDER.indexOf(methodName as Level);
    if (idx >= 0 && idx < threshold) return () => undefined;
    return function (this: { prefix?: string }, ...args: unknown[]) {
      if (this?.prefix) args.unshift(this.prefix);
      const m = methodName === "error" || methodName === "warn" || methodName === "info" || methodName === "debug" ? methodName : "log";
      // eslint-disable-next-line no-console
      console[m](...args);
    };
  };
  // New loggers (created later by getChild) inherit the factory…
  loglevel.methodFactory = factory;
  // …and existing ones are rebuilt with it.
  const all = [sdkLogger as unknown as loglevel.Logger, ...Object.values(loglevel.getLoggers())];
  for (const l of all) {
    l.methodFactory = factory;
    l.rebuild();
  }
}
