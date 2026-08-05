import type { ThreadId } from "@t3tools/contracts";

/** The kind of provider session a thread is running. Today only "trading" is special-cased. */
export type SessionProfileKind = "trading";

export interface SessionProfile {
  readonly threadId: ThreadId;
  readonly kind: SessionProfileKind;
}

const profilesByThread = new Map<ThreadId, SessionProfile>();

export function setSessionProfile(profile: SessionProfile): void {
  profilesByThread.set(profile.threadId, profile);
}

export function readSessionProfile(threadId: ThreadId): SessionProfile | undefined {
  return profilesByThread.get(threadId);
}

export function isTradingThread(threadId: ThreadId): boolean {
  return profilesByThread.get(threadId)?.kind === "trading";
}

export function clearSessionProfile(threadId: ThreadId): void {
  profilesByThread.delete(threadId);
}

export function clearAllSessionProfiles(): void {
  profilesByThread.clear();
}
