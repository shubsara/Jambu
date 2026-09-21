# Jambu — API

**Status:** Contract approved for P0; implemented across P3–P13
**Base URL:** `/api`
**Auth:** `Authorization: Bearer <accessToken>` on every route except
`/health` and `/api/auth/*`
**Timestamps:** ISO 8601 UTC (`2026-09-21T09:40:00Z`) everywhere (§28)

Endpoints marked **NEW (D5)** were added to close gaps where `CLAUDE.md`
requires behaviour that §23 had no endpoint for.

---

## 1. Conventions

### 1.1 Error envelope

```jsonc
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "activeSeconds must be >= 0",
    "details": { "field": "sessions[0].activeSeconds" }
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Schema validation failed (§31) |
| 401 | `UNAUTHENTICATED` | Missing/invalid/expired token |
| 403 | `FORBIDDEN` | Resource belongs to another user (§31) |
| 404 | `NOT_FOUND` | Resource does not exist for this user |
| 409 | `CONFLICT` | Idempotency or state conflict |
| 429 | `RATE_LIMITED` | Throttled |
| 500 | `INTERNAL` | Unexpected; details never leaked |

### 1.2 Authorization rule

Every user-scoped query is filtered by the authenticated user id. Requesting
another user's resource returns **403, never 404-by-accident**, and this is
asserted by tests at the API layer independently of RLS (see
`ARCHITECTURE.md` §4.3).

### 1.3 Privacy rule

No endpoint accepts or returns a full URL, page title, or page content.
Activity carries a **registrable domain only**. Payloads containing a path or
query are rejected with `VALIDATION_FAILED` (§9).

---

## 2. Health

### `GET /health`

Unauthenticated. Returns `200` with `{ "status": "ok", "version": "..." }`.

---

## 3. Auth

The API proxies Supabase Auth (D2). The extension never receives a Supabase
key of any kind.

### `POST /api/auth/register`

```jsonc
// request
{ "email": "a@b.com", "password": "...", "name": "Shubham", "timezone": "Asia/Kolkata" }
// 201
{ "user": { "id": "uuid", "email": "a@b.com", "name": "Shubham", "timezone": "Asia/Kolkata" },
  "accessToken": "...", "refreshToken": "...", "expiresAt": "2026-09-21T10:40:00Z" }
```

Creates the Supabase Auth user, the `users` row, and default
`user_preferences` (hydration **off**, persona `mom`).

### `POST /api/auth/login`

`{ "email", "password" }` → same shape as register, `200`.

### `POST /api/auth/refresh`

`{ "refreshToken" }` → `{ "accessToken", "refreshToken", "expiresAt" }`.

Tokens are never logged (§31).

---

## 4. Activity

### `POST /api/activity/session`

Accepts a **batch** of aggregated sessions, and — per D4 — returns any
intervention the ingest produced, so the common case needs no poll.

```jsonc
// request
{
  "sessions": [
    {
      "clientSessionId": "uuid",          // idempotency key
      "startedAt": "2026-09-21T09:40:00Z",
      "endedAt":   "2026-09-21T10:20:00Z",
      "activeSeconds": 2100,
      "domain": "notion.so"               // domain ONLY — no path, no query
    }
  ]
}
```

```jsonc
// 200
{
  "accepted": 1,
  "duplicates": 0,                         // idempotent replays, not errors
  "pendingInterventions": [                // D4 primary path
    {
      "id": "uuid",
      "type": "lunch",
      "persona": "mom",
      "message": "Hey! Have you taken your lunch? ❤️",
      "expiresAt": "2026-09-21T13:20:00Z"
    }
  ]
}
```

Re-sending the same `clientSessionId` is a no-op counted in `duplicates` — this
is what makes §26's retry-after-backoff safe.

---

## 5. User State

### `GET /api/user/state`

Derived, never stored (§12). Computed in the user's local timezone.

```jsonc
{
  "continuousWorkMinutes": 145,            // current session only (D6)
  "totalWorkMinutesToday": 320,            // local day, not UTC day
  "lastBreakMinutesAgo": 12,
  "lunchWindow": {
    "start": "2026-09-21T13:25:00Z",
    "end":   "2026-09-21T13:45:00Z",
    "confidence": 0.78,
    "source": "learned"                    // "learned" | "default"  (D8)
  },
  "lastLunchConfirmation": "2026-09-20T13:30:00Z",
  "lastInterventionAt": "2026-09-21T11:05:00Z",
  "currentActivity": "active",             // "active" | "idle" | "unknown"
  "paused": false
}
```

`source` exists so a default window (12:30–14:30 local, confidence `0`) is
never mistaken for a learned one — D8 requires the default stay visibly a
fallback.

---

## 6. Preferences

### `GET /api/preferences`

```jsonc
{
  "workStart": "09:30", "workEnd": "18:30",
  "lunchEnabled": true, "breakEnabled": true,
  "hydrationEnabled": false,               // opt-in (D7)
  "endDayEnabled": true,
  "persona": "mom"                         // D10
}
```

### `PUT /api/preferences`

Accepts a partial object; returns the full updated object. `persona` is
validated against the registry in `message-templates`; only `"mom"` is valid
in the MVP, and an unknown value returns `VALIDATION_FAILED` rather than being
silently stored.

---

## 7. Routines

### `GET /api/routines`

```jsonc
{
  "patterns": [
    { "type": "lunch", "dayOfWeek": null, "start": "13:25", "end": "13:45",
      "confidence": 0.78, "sampleCount": 16, "tier": "high" }
  ]
}
```

`tier` follows §16: `insufficient` (<3) · `low` (3–7) · `medium` (8–14) ·
`high` (15+). With `insufficient`, the API reports the default window and
`source: "default"` rather than personalizing (§16).

### `POST /api/routines/recalculate`

Recomputes from stored activity. Returns the updated patterns. Idempotent.

---

## 8. Interventions

### `POST /api/interventions`

Server-side creation path. Rejects with `409 CONFLICT` when a cooldown, an
active snooze, a pause, or a live intervention of another type applies —
cooldown is enforced here as well as in the engine, because the API is
authoritative (§32).

### `POST /api/interventions/:id/response`

```jsonc
// request
{ "response": "confirmed", "respondedAt": "2026-09-21T13:31:00Z" }
```

`response` ∈ `confirmed` · `not_yet` · `snoozed` · `dismissed` · `expired` (§18).

Side effects:

- `snoozed` → upserts `intervention_snoozes` for that **type only**
- `confirmed` on `lunch` → sets `lastLunchConfirmation`
- `confirmed` on `hydration` → satisfies D7's "no recent hydration confirmation"
- repeated `dismissed` → reduces future frequency for that type (§17), never
  increases it

Submitting a response twice is **idempotent**, not an error — the Care Card may
retry on a flaky connection. Responding to another user's intervention: `403`.

### `GET /api/interventions/today`

D4 fallback path, polled by `chrome.alarms`.

```jsonc
{
  "interventions": [
    { "id": "uuid", "type": "lunch", "persona": "mom",
      "message": "Hey! Have you taken your lunch? ❤️",
      "shownAt": null, "response": null,
      "expiresAt": "2026-09-21T13:20:00Z" }
  ]
}
```

"Today" is the user's **local** day (§28).

---

## 9. Pause — **NEW (D5)**

§14 scores "User paused Jambu −100" and §42 requires a pause control, but §23
defined no endpoint and §22 no column. Backed by `pause_states`.

### `GET /api/pause`

```jsonc
{ "paused": true, "pausedAt": "2026-09-21T14:00:00Z", "pausedUntil": null }
```

`pausedUntil: null` while `paused: true` means paused indefinitely.

### `POST /api/pause`

```jsonc
{ "until": "2026-09-21T18:00:00Z" }   // omit "until" to pause indefinitely
```

Returns the new pause state. Takes effect immediately: any live intervention
is expired and no new one is created while paused.

### `DELETE /api/pause`

Resumes. Returns `{ "paused": false }`. Idempotent when not paused.

---

## 10. Snooze — **NEW (D5)**

§17 requires "respect snooze"; snooze state is per type so snoozing lunch does
not silence breaks. Backed by `intervention_snoozes`.

### `GET /api/snoozes`

```jsonc
{ "snoozes": [ { "type": "lunch", "snoozedUntil": "2026-09-21T14:15:00Z" } ] }
```

### `POST /api/snoozes`

```jsonc
{ "type": "lunch", "until": "2026-09-21T14:15:00Z" }
```

Normally created implicitly by a `snoozed` response; this endpoint exists for
the settings UI. Upserts.

### `DELETE /api/snoozes/:type`

Clears the snooze for one type. Idempotent.

---

## 11. Data Export and Deletion — **NEW (D5)**

§42 requires "user can delete their activity/account data"; §23 had no
endpoint. Backed by `deletion_requests` (audit rows carry no personal data).

### `GET /api/user/export`

Returns everything Jambu holds for the authenticated user: profile,
preferences, activity sessions, routine patterns, interventions, pause and
snooze state. Contains no page content, because none is ever collected (§9).

### `DELETE /api/user/activity`

Deletes **activity and derived data**, keeping the account:

- all `activity_sessions`
- all `routine_patterns`
- all `interventions`

Preferences, pause and snooze state survive. Requires
`{ "confirm": "DELETE_ACTIVITY" }` in the body. Irreversible; the response
states so.

```jsonc
// 200
{ "deleted": { "activitySessions": 412, "routinePatterns": 4, "interventions": 37 },
  "deletionRequestId": "uuid" }
```

### `DELETE /api/user/account`

Deletes the account and all associated data:

1. hard-deletes activity, routines, interventions, preferences, pause, snoozes
2. sets `users.deleted_at`
3. deletes the Supabase Auth user
4. records a `deletion_requests` row (`scope: 'account'`), which holds only an
   opaque user id and timestamps

Requires `{ "confirm": "DELETE_ACCOUNT" }`. All tokens are invalidated.
Irreversible.

### `GET /api/user/deletion-request/:id`

Status of a deletion (`pending` · `completed` · `failed`), so the UI can
confirm completion rather than assume it.

---

## 12. Endpoint Summary

| Method | Path | Phase | Source |
|---|---|---|---|
| GET | `/health` | P3 | §23 |
| POST | `/api/auth/register` | P3 | §23 |
| POST | `/api/auth/login` | P3 | §23 |
| POST | `/api/auth/refresh` | P3 | §23 |
| POST | `/api/activity/session` | P4 | §23 |
| GET | `/api/user/state` | P5 | §23 |
| GET | `/api/preferences` | P12 | §23 |
| PUT | `/api/preferences` | P12 | §23 |
| GET | `/api/routines` | P11 | §23 |
| POST | `/api/routines/recalculate` | P11 | §23 |
| POST | `/api/interventions` | P7 | §23 |
| POST | `/api/interventions/:id/response` | P7 | §23 |
| GET | `/api/interventions/today` | P7 | §23 |
| GET | `/api/pause` | P13 | **NEW (D5)** |
| POST | `/api/pause` | P13 | **NEW (D5)** |
| DELETE | `/api/pause` | P13 | **NEW (D5)** |
| GET | `/api/snoozes` | P13 | **NEW (D5)** |
| POST | `/api/snoozes` | P13 | **NEW (D5)** |
| DELETE | `/api/snoozes/:type` | P13 | **NEW (D5)** |
| GET | `/api/user/export` | P13 | **NEW (D5)** |
| DELETE | `/api/user/activity` | P13 | **NEW (D5)** |
| DELETE | `/api/user/account` | P13 | **NEW (D5)** |
| GET | `/api/user/deletion-request/:id` | P13 | **NEW (D5)** |

Contracts are typed once in `packages/shared-types` and imported by both
`apps/api` and `apps/extension`, so the two cannot drift (§23, §32).
