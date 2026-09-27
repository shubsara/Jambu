/**
 * Intervention lifecycle.
 *
 * Turns a Care Engine decision into a durable, answerable row and records the
 * answer. The API is authoritative (CLAUDE.md §32), so pause, snooze and
 * cooldown are re-checked here even though the engine already suppressed them
 * — the engine's view of the world could be stale by the time we write.
 *
 * The score and reason produced by the engine are persisted verbatim. They are
 * never recomputed or rewritten at persistence time: §13 requires the decision
 * be explainable, and an explanation edited after the fact explains nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TYPE_PRIORITY, decide, suppressionFor } from '@jambu/care-engine';
import { selectMessage } from '@jambu/message-templates';
import type {
  CareContext,
  InterventionResponseType,
  InterventionTrigger,
  InterventionType,
} from '@jambu/shared-types';

import { emit } from '../lib/analytics.js';
import { ApiError } from '../errors.js';
import { assembleCareContext } from './care-context.js';

/** The shape returned to clients (docs/API.md §8). */
export interface InterventionView {
  readonly id: string;
  readonly type: InterventionType;
  readonly persona: string;
  readonly message: string;
  readonly shownAt: string | null;
  readonly response: InterventionResponseType | null;
  readonly expiresAt: string;
}

const VIEW_COLUMNS = 'id, type, persona, message, shown_at, response, expires_at';

interface InterventionRow {
  readonly id: string;
  readonly type: string;
  readonly persona: string;
  readonly message: string;
  readonly shown_at: string | null;
  readonly response: string | null;
  readonly expires_at: string;
}

function toView(row: InterventionRow): InterventionView {
  return {
    id: row.id,
    type: row.type as InterventionType,
    persona: row.persona,
    message: row.message,
    shownAt: row.shown_at,
    response: row.response as InterventionResponseType | null,
    expiresAt: row.expires_at,
  };
}

/**
 * Expire anything past its deadline (decision D50).
 *
 * Idempotent by construction: the filter only matches unanswered rows that are
 * already past `expires_at`, so running it twice changes nothing the second
 * time. Run lazily rather than on a schedule — P7 introduces no scheduler.
 */
export async function expireStale(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<number> {
  const { data, error } = await admin
    .from('interventions')
    .update({ response: 'expired', responded_at: now.toISOString() })
    .eq('user_id', userId)
    .is('response', null)
    .lte('expires_at', now.toISOString())
    // `type` joins the existing `id` selection so the sweep can report one
    // §29 event per expired intervention rather than a single bulk figure.
    .select('id, type');

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Interventions could not be updated.');
  }

  const expired = (data ?? []) as { id: string; type: InterventionType }[];
  for (const row of expired) {
    emit({
      event: 'intervention_expired',
      occurredAt: now.toISOString(),
      userId,
      interventionType: row.type,
    });
  }
  return expired.length;
}

/** The one unanswered, unexpired intervention, if any. */
export async function findLive(
  admin: SupabaseClient,
  userId: string,
  now: Date,
): Promise<InterventionView | null> {
  const { data, error } = await admin
    .from('interventions')
    .select(VIEW_COLUMNS)
    .eq('user_id', userId)
    .is('response', null)
    .gt('expires_at', now.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Interventions could not be read.');
  }
  return data === null ? null : toView(data as InterventionRow);
}

export type CreateOutcome =
  | { readonly status: 'created'; readonly intervention: InterventionView }
  | { readonly status: 'existing'; readonly intervention: InterventionView }
  | { readonly status: 'suppressed'; readonly reason: string }
  | { readonly status: 'declined'; readonly reason: string };

export interface CreateOptions {
  readonly expiryMinutes: number;
  readonly trigger: InterventionTrigger;
}

/**
 * Whether every type the user has enabled is currently suppressed.
 *
 * Decision D45 separates "pause, snooze or cooldown forbids this" (409) from
 * "the engine considered it and said no" (204). The engine reports both as
 * `shouldIntervene: false`, so suppression is asked about directly using the
 * engine's own exported check rather than reimplementing the rules here.
 */
function blanketSuppression(context: CareContext): string | null {
  const reasons: string[] = [];
  for (const type of TYPE_PRIORITY) {
    const suppression = suppressionFor(context, type);
    if (suppression === null) {
      return null;
    }
    reasons.push(`${type}: ${suppression}`);
  }
  return reasons.join('; ');
}

/**
 * Evaluate and, if warranted, create an intervention.
 *
 * The client supplies nothing: the server builds the context, calls the
 * engine, and renders the message. A client cannot nominate a decision, score,
 * reason, persona, message or expiry.
 */
export async function createIfWarranted(
  admin: SupabaseClient,
  userId: string,
  now: Date,
  options: CreateOptions,
): Promise<CreateOutcome> {
  await expireStale(admin, userId, now);

  // At most one live intervention at a time (docs/ARCHITECTURE.md §7.4). This
  // also makes a retried request safe: it returns what already exists rather
  // than creating a second card.
  const live = await findLive(admin, userId, now);
  if (live !== null) {
    return { status: 'existing', intervention: live };
  }

  const { context, previousMessageByType } = await assembleCareContext(
    admin,
    userId,
    now,
  );

  const suppressed = blanketSuppression(context);
  if (suppressed !== null) {
    return { status: 'suppressed', reason: suppressed };
  }

  const decision = decide(context);
  if (!decision.shouldIntervene || decision.interventionType === null) {
    return { status: 'declined', reason: decision.reason };
  }

  const type = decision.interventionType;
  const persona = context.preferences.persona;

  // Decision D43: the seed is how many of this type the user has already seen,
  // so message choice rotates deterministically without a clock or randomness.
  const { count, error: countError } = await admin
    .from('interventions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('type', type);

  if (countError !== null) {
    throw new ApiError('INTERNAL', 'Interventions could not be read.');
  }

  const previousMessage = previousMessageByType[type];
  const message = selectMessage({
    personaId: persona,
    interventionType: type,
    seed: count ?? 0,
    ...(previousMessage === undefined ? {} : { previousMessage }),
  });

  const { data, error } = await admin
    .from('interventions')
    .insert({
      user_id: userId,
      type,
      trigger: options.trigger,
      persona,
      message,
      // Persisted exactly as the engine produced them (§13).
      score: decision.score,
      reason: decision.reason,
      expires_at: new Date(now.getTime() + options.expiryMinutes * 60_000).toISOString(),
      shown_at: now.toISOString(),
    })
    .select(VIEW_COLUMNS)
    .single();

  if (error !== null || data === null) {
    throw new ApiError('INTERNAL', 'The intervention could not be created.');
  }

  // Decision D111: this is "created / delivery attempted", not an impression.
  // `shown_at` above keeps its D70 creation-time meaning and is unchanged.
  emit({
    event: 'intervention_shown',
    occurredAt: now.toISOString(),
    userId,
    interventionType: type,
    trigger: options.trigger,
    score: decision.score,
  });

  return { status: 'created', intervention: toView(data as InterventionRow) };
}

export type RespondOutcome =
  | { readonly status: 'recorded'; readonly intervention: InterventionView }
  | { readonly status: 'already-answered'; readonly intervention: InterventionView };

/**
 * Record a user's answer.
 *
 * First write wins. A repeat submission returns the stored answer unchanged
 * rather than erroring: the care card may retry on a flaky connection, and
 * punishing that would lose the user's response (docs/API.md §8).
 */
export async function recordResponse(
  admin: SupabaseClient,
  actorId: string,
  interventionId: string,
  response: InterventionResponseType,
  respondedAt: Date,
  snoozeMinutes: number,
): Promise<RespondOutcome> {
  const { data: existing, error } = await admin
    .from('interventions')
    .select(`${VIEW_COLUMNS}, user_id`)
    .eq('id', interventionId)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('INTERNAL', 'The intervention could not be read.');
  }
  if (existing === null) {
    throw new ApiError('NOT_FOUND', 'The requested resource does not exist.');
  }

  const row = existing as InterventionRow & { user_id: string };
  if (row.user_id !== actorId) {
    // 403, never a 404 that would let someone probe for valid ids.
    throw new ApiError('FORBIDDEN', 'You do not have access to this resource.');
  }

  if (row.response !== null) {
    return { status: 'already-answered', intervention: toView(row) };
  }

  const { data: updated, error: updateError } = await admin
    .from('interventions')
    .update({ response, responded_at: respondedAt.toISOString() })
    .eq('id', interventionId)
    .eq('user_id', actorId)
    // Guards against two concurrent submissions: the second matches no row.
    .is('response', null)
    .select(VIEW_COLUMNS)
    .maybeSingle();

  if (updateError !== null) {
    throw new ApiError('INTERNAL', 'The response could not be recorded.');
  }

  if (updated === null) {
    // Someone else won the race; return what was stored.
    const settled = await admin
      .from('interventions')
      .select(VIEW_COLUMNS)
      .eq('id', interventionId)
      .eq('user_id', actorId)
      .single();
    return {
      status: 'already-answered',
      intervention: toView(settled.data as InterventionRow),
    };
  }

  // The transition happened in *this* request - `updated === null` above is
  // the concurrent-submission and repeat-submission path, and returns before
  // reaching here. That is what makes this once per occurrence.
  //
  // `not_yet` is deliberately unmapped: CLAUDE.md §29 names no event for it,
  // and P14 does not add one. `expired` never arrives here either - the
  // request schema rejects it, because expiry is the server's to declare.
  const OUTCOME_EVENTS = {
    confirmed: 'intervention_confirmed',
    snoozed: 'intervention_snoozed',
    dismissed: 'intervention_dismissed',
  } as const;
  const outcome = OUTCOME_EVENTS[response as keyof typeof OUTCOME_EVENTS];
  if (outcome !== undefined) {
    emit({
      event: outcome,
      occurredAt: respondedAt.toISOString(),
      userId: actorId,
      interventionType: row.type as InterventionType,
    });
  }

  if (response === 'snoozed') {
    // Scoped to this type only: snoozing lunch must not silence breaks (D5).
    const { error: snoozeError } = await admin.from('intervention_snoozes').upsert(
      {
        user_id: actorId,
        type: row.type,
        snoozed_until: new Date(
          respondedAt.getTime() + snoozeMinutes * 60_000,
        ).toISOString(),
        source_intervention_id: interventionId,
      },
      { onConflict: 'user_id,type' },
    );
    if (snoozeError !== null) {
      throw new ApiError('INTERNAL', 'The snooze could not be recorded.');
    }
  }

  return { status: 'recorded', intervention: toView(updated as InterventionRow) };
}

/** Today's interventions, in the user's local day (CLAUDE.md §28). */
export async function listForDay(
  admin: SupabaseClient,
  userId: string,
  dayStart: Date,
): Promise<InterventionView[]> {
  const { data, error } = await admin
    .from('interventions')
    .select(VIEW_COLUMNS)
    .eq('user_id', userId)
    .gte('created_at', dayStart.toISOString())
    .order('created_at', { ascending: true });

  if (error !== null) {
    throw new ApiError('INTERNAL', 'Interventions could not be read.');
  }
  return ((data ?? []) as InterventionRow[]).map(toView);
}
