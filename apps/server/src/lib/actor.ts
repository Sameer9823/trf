import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is really behind the current request. For a person signed in as
 * themselves, actorEmployeeId is their own id and accountId is null. For a
 * shared team login it is the member who chose their name and entered their
 * PIN, and accountId is the team account they are working through.
 *
 * It lives in AsyncLocalStorage so the audit writer can attribute every row
 * without each of the many call sites having to pass it along.
 */
export interface ActorContext {
  actorEmployeeId: number | null;
  accountId: number | null;
}

export const actorStore = new AsyncLocalStorage<ActorContext>();

export function currentActor(): ActorContext | undefined {
  return actorStore.getStore();
}
