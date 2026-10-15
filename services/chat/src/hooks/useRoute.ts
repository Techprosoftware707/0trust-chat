import { useEffect, useState } from "react";
import { parseRoute, type Route } from "../lib/matrix-id";

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function navigate(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}
