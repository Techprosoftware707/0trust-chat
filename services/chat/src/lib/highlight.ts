/** One-shot "scroll to this event" requests (from search results to the timeline). */
let pending: { roomId: string; eventId: string } | null = null;
const listeners = new Set<() => void>();

export function requestHighlight(roomId: string, eventId: string): void {
  pending = { roomId, eventId };
  listeners.forEach((l) => l());
}

export function consumeHighlight(roomId: string): string | null {
  if (!pending || pending.roomId !== roomId) return null;
  const id = pending.eventId;
  if (!document.getElementById(`ev-${id}`)) return null; // not rendered (yet)
  pending = null;
  return id;
}

export function subscribeHighlight(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
