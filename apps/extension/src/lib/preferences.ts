/**
 * Preferences client (docs/API.md §6).
 *
 * The extension never decides what a preference means — it reads and writes
 * what the API says. `onboardingCompletedAt` in particular is cached locally
 * only as an echo of a server response (resolution A1); nothing here infers
 * completion, because D93 turns completion into permission to observe someone.
 */
import type { OnboardingSubmission, PreferencesView } from '@jambu/shared-types';

import { authedRequest, type ApiClientDeps } from './api-client.js';
import { cacheOnboardingCompletedAt } from './storage.js';

export async function fetchPreferences(deps?: ApiClientDeps): Promise<PreferencesView> {
  const preferences = await authedRequest<PreferencesView>(
    '/api/preferences',
    { method: 'GET' },
    deps,
  );
  await cacheOnboardingCompletedAt(preferences.onboardingCompletedAt);
  return preferences;
}

/**
 * Apply a partial preference update (docs/API.md §6).
 *
 * The settings page's only writer. Onboarding uses `submitOnboarding`, whose
 * narrower type is the §3.2 guard.
 */
export async function updatePreferences(
  body: Partial<Record<string, unknown>>,
  deps?: ApiClientDeps,
): Promise<PreferencesView> {
  return await put(body, deps);
}

async function put(body: unknown, deps?: ApiClientDeps): Promise<PreferencesView> {
  const preferences = await authedRequest<PreferencesView>(
    '/api/preferences',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    deps,
  );
  await cacheOnboardingCompletedAt(preferences.onboardingCompletedAt);
  return preferences;
}

/**
 * Finish onboarding: the toggles, the timezone and the completion flag, in one
 * call.
 *
 * The parameter type is {@link OnboardingSubmission}, which has no field for a
 * lunch time, water schedule, break schedule or work hours (D88, constraint 2).
 * That is the primary §3.2 guard — a schedule question has nowhere to go.
 */
export async function submitOnboarding(
  submission: OnboardingSubmission,
  deps?: ApiClientDeps,
): Promise<PreferencesView> {
  return await put(submission, deps);
}
