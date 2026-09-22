/**
 * Scheduling (decision D64, ARCHITECTURE.md §5.3).
 *
 * `chrome.alarms` rather than `setTimeout`: MV3 terminates an idle service
 * worker and pending timers die with it. Lint enforces this in background
 * code, so the rule cannot quietly erode.
 */
import { pollInterventions } from './intervention-poll.js';
import { syncBufferedActivity } from './sync.js';

/** Decision D64 — the periodic flush, also ARCHITECTURE.md §5.2's fallback tick. */
export const SYNC_ALARM_NAME = 'jambu:sync';
export const SYNC_PERIOD_MINUTES = 5;

export function registerAlarms(alarms = globalThis.chrome?.alarms): void {
  if (alarms === undefined) {
    return;
  }

  alarms.create?.(SYNC_ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES });

  alarms.onAlarm?.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM_NAME) {
      return;
    }
    // Decision D73: one cadence. Sync first, so the primary path gets the
    // chance to deliver before the fallback poll looks for anything missed.
    void syncBufferedActivity().then(() => pollInterventions(new Date()));
  });
}
