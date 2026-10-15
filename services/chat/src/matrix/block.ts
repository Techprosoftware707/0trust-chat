/**
 * Blocking is Matrix "ignoring" (`m.ignored_user_list` account data). The homeserver then stops
 * delivering the person's messages and invites to every device of this account; the person isn't
 * told, but their homeserver can't see the list either (account data stays on our server).
 * Messages that arrived while they were blocked are not delivered again after unblocking.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { isValidUserId } from "../lib/matrix-id";

export function canBlock(client: MatrixClient, userId: string): boolean {
  return isValidUserId(userId) && userId !== client.getUserId();
}

export async function blockUser(client: MatrixClient, userId: string): Promise<void> {
  if (!canBlock(client, userId)) throw new Error("This person can't be blocked.");
  const current = client.getIgnoredUsers();
  if (current.includes(userId)) return;
  await client.setIgnoredUsers([...current, userId]);
}

export async function unblockUser(client: MatrixClient, userId: string): Promise<void> {
  const current = client.getIgnoredUsers();
  if (!current.includes(userId)) return;
  await client.setIgnoredUsers(current.filter((u) => u !== userId));
}

