/**
 * Pause, snooze, export and deletion client (docs/API.md §9-11).
 *
 * A thin layer over the P13 endpoints. It decides nothing: durations come from
 * `PAUSE_CHOICES` below, and everything else is whatever the API said.
 *
 * Account deletion is confirmed by its `202` (D104/D107) — there is
 * deliberately no polling helper for it, because the token that would do the
 * polling is destroyed by the deletion itself.
 */
import type { InterventionType } from '@jambu/shared-types';

import { authedRequest, type ApiClientDeps } from './api-client.js';

export interface PauseState {
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly pausedUntil: string | null;
}

export interface SnoozeView {
  readonly type: InterventionType;
  readonly snoozedUntil: string;
}

export interface DeletionAccepted {
  readonly deletionRequestId: string;
  readonly scope: 'activity' | 'account';
  readonly status: 'pending' | 'completed' | 'failed';
  readonly message: string;
}

export interface DeletionRequestView {
  readonly id: string;
  readonly scope: 'activity' | 'account';
  readonly status: 'pending' | 'completed' | 'failed';
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function fetchPause(deps?: ApiClientDeps): Promise<PauseState> {
  return await authedRequest<PauseState>('/api/pause', { method: 'GET' }, deps);
}

/**
 * Start a pause.
 *
 * `until` omitted means indefinitely, which is what the API expects for a
 * bodyless pause (§9).
 */
export async function startPause(
  until: Date | null,
  deps?: ApiClientDeps,
): Promise<PauseState> {
  return await authedRequest<PauseState>(
    '/api/pause',
    { method: 'POST', ...json(until === null ? {} : { until: until.toISOString() }) },
    deps,
  );
}

export async function endPause(deps?: ApiClientDeps): Promise<PauseState> {
  return await authedRequest<PauseState>('/api/pause', { method: 'DELETE' }, deps);
}

export async function fetchSnoozes(deps?: ApiClientDeps): Promise<SnoozeView[]> {
  const result = await authedRequest<{ snoozes: SnoozeView[] }>(
    '/api/snoozes',
    { method: 'GET' },
    deps,
  );
  return result.snoozes;
}

/** Clear one type's snooze. There is no way to create one — decision D102. */
export async function clearSnooze(
  type: InterventionType,
  deps?: ApiClientDeps,
): Promise<SnoozeView[]> {
  const result = await authedRequest<{ snoozes: SnoozeView[] }>(
    `/api/snoozes/${type}`,
    { method: 'DELETE' },
    deps,
  );
  return result.snoozes;
}

export async function fetchExport(deps?: ApiClientDeps): Promise<unknown> {
  return await authedRequest<unknown>('/api/user/export', { method: 'GET' }, deps);
}

export async function deleteActivity(
  confirm: string,
  deps?: ApiClientDeps,
): Promise<DeletionAccepted> {
  return await authedRequest<DeletionAccepted>(
    '/api/user/activity',
    { method: 'DELETE', ...json({ confirm }) },
    deps,
  );
}

export async function deleteAccount(
  confirm: string,
  deps?: ApiClientDeps,
): Promise<DeletionAccepted> {
  return await authedRequest<DeletionAccepted>(
    '/api/user/account',
    { method: 'DELETE', ...json({ confirm }) },
    deps,
  );
}

/**
 * Poll an **activity** deletion to completion (decision D104).
 *
 * Account scope has no equivalent and must not grow one: its `202` is the
 * confirmation, because finishing it invalidates the token this would use.
 */
export async function fetchDeletionRequest(
  id: string,
  deps?: ApiClientDeps,
): Promise<DeletionRequestView> {
  return await authedRequest<DeletionRequestView>(
    `/api/user/deletion-request/${id}`,
    { method: 'GET' },
    deps,
  );
}

export interface PauseChoice {
  readonly id: string;
  readonly label: string;
  /** Resolves the end instant for this choice. */
  readonly resolve: (now: Date, workEnd: string) => Date;
}

function minutesFromNow(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * "Rest of day" ends at the user's work-end (decision D101).
 *
 * The caller supplies `workEnd` from preferences, which P11 keeps aligned with
 * the learned work-end (D84). If that time has already passed today, the pause
 * runs to local midnight instead — a pause ending in the past is refused by
 * the API, which would leave the user with no pause at all.
 */
export function restOfDay(now: Date, workEnd: string): Date {
  const [hours, minutes] = workEnd.split(':').map(Number);
  const end = new Date(now);
  end.setHours(hours ?? 18, minutes ?? 0, 0, 0);

  if (end <= now) {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return midnight;
  }
  return end;
}

/**
 * The pause durations offered (decision D98).
 *
 * Four, exactly: 30 minutes, 1 hour, 2 hours, rest of day. The mockup's
 * "Custom time" is deliberately absent — it was not among the approved
 * choices, and a custom picker is the scheduling chore CLAUDE.md §3.2 avoids.
 */
export const PAUSE_CHOICES: readonly PauseChoice[] = [
  { id: '30m', label: '30 minutes', resolve: (now) => minutesFromNow(now, 30) },
  { id: '1h', label: '1 hour', resolve: (now) => minutesFromNow(now, 60) },
  { id: '2h', label: '2 hours', resolve: (now) => minutesFromNow(now, 120) },
  { id: 'rest-of-day', label: 'Rest of day', resolve: restOfDay },
];
