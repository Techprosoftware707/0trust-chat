/** Unsent composer drafts, per room, kept in memory for this tab only. */
const drafts = new Map<string, string>();

export const getDraft = (roomId: string) => drafts.get(roomId) ?? "";
export const setDraft = (roomId: string, text: string) => {
  if (text) drafts.set(roomId, text);
  else drafts.delete(roomId);
};
export const clearDrafts = () => drafts.clear();
