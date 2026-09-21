# Jambu — Claude Code Project Instructions

## 1. Role

You are the primary engineering agent for **Jambu**.

Jambu is a digital care companion for people who spend long periods working on a laptop. It quietly observes high-level work patterns, learns the user's routine, and gives small, warm interventions when the user may have forgotten basic self-care.

The core experience is:

> **"Hey! ❤️ Have you taken your lunch?" — Mom**

Jambu is intentionally **not** a generic reminder app, to-do list, productivity tracker, chatbot, or medical app.

The core product principle is:

> **Jambu should know when to care — and when not to interrupt.**

Your job is to build a reliable, privacy-conscious MVP around that principle.

---

# 2. Current Product Scope

## MVP platform

Build the MVP as:

- Chrome Extension
- Cloud API
- PostgreSQL database
- Deterministic Care Engine
- Routine Learning Engine
- Small care notification UI

Do **not** build the desktop companion in the MVP.

The desktop companion is a future phase.

## MVP intervention types

Only implement these initially:

1. Lunch
2. Break
3. Hydration
4. End of workday

Do not expand the intervention catalog without explicit approval.

---

# 3. Product Philosophy

### 3.1 Care, don't nag

Jambu must be comfortable doing nothing.

A notification is an intervention, not the default behavior.

If the user is focused, Jambu should stay quiet unless there is a strong reason to interrupt.

### 3.2 Minimal user configuration

Do not require users to manually schedule every behavior.

Avoid requiring:

- lunch time
- water reminders
- break schedules
- detailed routines

Instead:

1. collect a few useful preferences during onboarding;
2. observe high-level behavior;
3. infer patterns;
4. gradually personalize intervention timing.

### 3.3 Human tone

Prefer:

> "Hey! Have you taken your lunch? ❤️"

over:

> "Reminder: It is time for lunch."

Prefer:

> "You've been working for a while. How about a little break?"

over:

> "You have exceeded the recommended continuous work period."

The product should feel warm, familiar, and non-judgmental.

### 3.4 The intervention is the product

The popup is more important than a dashboard.

The MVP dashboard should remain simple.

Do not turn Jambu into a productivity analytics product.

---

# 4. Product Positioning

Use this conceptual positioning internally:

> **A little digital companion that looks out for you while you work.**

Do not position the MVP as:

- a medical device
- a doctor
- a nutritionist
- a therapist
- a health diagnostic system
- an AI productivity coach

Jambu can encourage ordinary healthy habits, but it must not make medical claims or diagnose health conditions.

---

# 5. First Milestone: The "Mom Moment"

The first meaningful milestone is:

1. User installs Jambu.
2. User completes lightweight onboarding.
3. User works normally.
4. Jambu observes high-level activity.
5. Jambu detects a likely lunch window.
6. User has been continuously active for a significant period.
7. Care Engine decides intervention is appropriate.
8. A small care card appears.
9. User sees:

   "Hey! ❤️

   Have you taken your lunch?

   [ Yes, I have ] [ Remind me later ]

   — Mom ❤️"

10. User responds.
11. Response is recorded.
12. Jambu learns from that response.

Do not move on to large features before this loop works reliably.

---

# 6. Technology Stack

Use the following stack unless there is a strong technical reason to change it.

## Extension

- React
- TypeScript
- Chrome Manifest V3
- Tailwind CSS

## Backend

- Node.js
- TypeScript
- Fastify

## Database

- PostgreSQL

Supabase may be used for PostgreSQL and authentication if it materially reduces implementation complexity.

## Package management

- pnpm
- pnpm workspaces

## Testing

- Vitest
- integration tests where appropriate

## Observability

- Sentry for errors
- PostHog for product analytics, if required

## Version control

- GitHub
- feature branches
- small, meaningful commits

## Future desktop application

Do not implement in MVP.

Preferred future technology:

- Tauri

---

# 7. Repository Architecture

Prefer this structure:

```text
jambu/
│
├── apps/
│   ├── extension/
│   └── api/
│
├── packages/
│   ├── care-engine/
│   ├── routine-learning/
│   ├── shared-types/
│   └── message-templates/
│
├── database/
│   ├── migrations/
│   └── seed/
│
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── API.md
│   └── IMPLEMENTATION_PLAN.md
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── README.md
└── CLAUDE.md
```

Keep the Care Engine independent from the UI.

The Chrome extension should never contain the authoritative Care Engine logic.

---

# 8. Architectural Principle

The system should follow this conceptual flow:

```text
User activity
      ↓
Activity aggregation
      ↓
User state
      ↓
Routine learning
      ↓
Care Engine
      ↓
Intervention decision
      ↓
Message selection/generation
      ↓
Care Card
      ↓
User response
      ↓
Response stored
      ↓
Routine/intervention model improves
```

The Care Engine decides **whether** to intervene.

The message layer decides **how to say it**.

Keep these concerns separate.

---

# 9. Privacy Is a Core Product Requirement

Jambu should know:

> **How long the user has been working, not what they are working on.**

## Allowed data

Collect only what is necessary for MVP functionality, such as:

- active browser state
- active tab/domain
- timestamps
- session duration
- idle state
- aggregated activity duration
- intervention history
- user preferences
- routine statistics

Example:

```json
{
  "domain": "notion.so",
  "startedAt": "2026-09-20T09:40:00Z",
  "endedAt": "2026-09-20T10:20:00Z",
  "activeSeconds": 2100
}
```

## Never collect

Do not collect:

- keystrokes
- passwords
- page contents
- email contents
- private messages
- form inputs
- screenshots
- clipboard contents
- document contents
- credentials

Do not add any such collection without explicit product approval.

## Data minimization

Prefer aggregated sessions over raw event streams.

For example, prefer:

```text
10:00–10:30
active
notion.so
```

instead of storing every user interaction.

---

# 10. Chrome Extension Requirements

Use Manifest V3.

The extension should contain:

```text
background/service worker
popup UI
onboarding UI
settings UI
care card/notification UI
API client
local activity buffer
```

The background service worker should be responsible for:

- activity session management
- idle detection
- periodic synchronization
- receiving care decisions
- notification orchestration

Do not put business-critical logic only inside the popup.

The popup may not be open when the Care Engine needs to act.

---

# 11. Activity Tracking

The MVP should track:

- active tab/domain
- session start
- session end
- active duration
- browser idle state

Activity should be aggregated.

Example:

```typescript
interface ActivitySession {
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  domain?: string;
}
```

Do not store page URLs when the domain is sufficient.

Avoid excessive network calls.

Use local buffering and batch synchronization where practical.

---

# 12. User State

The backend should be able to derive a lightweight current state.

Example:

```typescript
interface UserState {
  continuousWorkMinutes: number;
  totalWorkMinutesToday: number;
  lastBreakMinutesAgo?: number;
  lunchWindow?: {
    start: string;
    end: string;
    confidence: number;
  };
  lastLunchConfirmation?: string;
  lastInterventionAt?: string;
  currentActivity: "active" | "idle" | "unknown";
}
```

The state should be derived from stored activity and routine data.

Avoid storing unnecessary duplicate state unless performance requires it.

---

# 13. Care Engine

The Care Engine must be:

- deterministic
- testable
- explainable
- independent from the LLM
- independent from the notification UI

Example interface:

```typescript
interface CareContext {
  currentTime: Date;
  continuousWorkMinutes: number;
  totalWorkMinutesToday: number;
  lunchWindow?: {
    start: Date;
    end: Date;
    confidence: number;
  };
  breakPattern?: {
    averageIntervalMinutes: number;
    confidence: number;
  };
  lastLunchConfirmation?: Date;
  lastIntervention?: Date;
  preferences: UserPreferences;
  currentActivity: "active" | "idle" | "unknown";
}
```

Output:

```typescript
interface CareDecision {
  shouldIntervene: boolean;
  interventionType:
    | "lunch"
    | "break"
    | "hydration"
    | "end_of_day"
    | null;
  score: number;
  reason: string;
}
```

---

# 14. Initial Care Scoring

Use deterministic scoring for MVP.

Suggested initial rules:

```text
Lunch window active                 +30
Continuous work > 120 minutes       +25
Continuous work > 180 minutes       +20
Historical pattern confidence       +20
User currently active                +10
No recent intervention              +10

Recent intervention                 -20
Recent dismissal                    -25
Recent snooze                       -20
Outside normal work period          -30
User paused Jambu                   -100
```

Initial thresholds:

```text
0–39     → do not intervene
40–69    → monitor
70+      → intervene
```

These numbers are starting points, not permanent product truth.

Keep the scoring configuration easy to change.

---

# 15. Important Care Engine Rule

The Care Engine should never blindly remind based only on time.

Bad:

```text
13:00 → send lunch reminder
```

Better:

```text
Likely lunch window
+
significant continuous activity
+
user is active
+
no lunch confirmation
+
no recent intervention
=
possible care intervention
```

The objective is **contextual care**, not clock-based reminders.

---

# 16. Routine Learning

Create a separate Routine Learning module.

Initially learn:

- approximate work start
- approximate work end
- lunch window
- break interval

For lunch, prefer robust statistics such as median.

Example observations:

```text
13:20
13:42
13:35
13:29
13:38
```

Potential learned result:

```json
{
  "type": "lunch",
  "start": "13:25",
  "end": "13:45",
  "confidence": 0.78
}
```

## Minimum observation rules

```text
< 3 observations
→ generic/default behavior

3–7 observations
→ low confidence

8–14 observations
→ medium confidence

15+ observations
→ high confidence
```

Do not over-personalize based on insufficient data.

Outliers should not radically shift the learned pattern.

---

# 17. Intervention Frequency

Jambu must avoid becoming annoying.

Implement cooldowns.

At minimum:

- avoid duplicate interventions within a short window
- respect snooze
- reduce frequency after repeated dismissals
- respect user pause
- avoid overlapping intervention types

Example:

```text
Lunch notification
     ↓
User dismisses repeatedly
     ↓
Reduce lunch intervention frequency
```

Repeated dismissal is a signal.

It should not be interpreted as a reason to notify more aggressively.

---

# 18. Intervention Responses

Supported responses:

```text
confirmed
not_yet
snoozed
dismissed
expired
```

Example:

```typescript
interface InterventionResponse {
  interventionId: string;
  response:
    | "confirmed"
    | "not_yet"
    | "snoozed"
    | "dismissed"
    | "expired";
  respondedAt: string;
}
```

The response must be persisted.

---

# 19. Care Card UI

The care card should be:

- compact
- warm
- non-intrusive
- visually polished
- accessible
- responsive
- easy to dismiss

Visual direction:

- soft neutral background
- rounded corners
- subtle shadow
- warm mother avatar
- restrained use of heart/emoji
- readable typography
- minimal text
- clear primary action

Example:

```text
┌────────────────────────────────────┐
│ 👩  Hey! ❤️                         │
│                                    │
│     Have you taken your lunch?     │
│                                    │
│     [ Yes, I have ]                │
│     [ Remind me later ]            │
│                                    │
│                         — Mom ❤️   │
└────────────────────────────────────┘
```

The card should not cover a significant portion of the user's screen.

Do not use intrusive full-screen modals.

---

# 20. Message Templates

For MVP, use deterministic templates.

Example:

```typescript
const lunchMessages = [
  "Hey! Have you taken your lunch? ❤️",
  "Just checking in... have you had lunch yet?",
  "Hey, don't forget to eat something. ❤️",
  "You've been working for a while. Have you eaten?"
];
```

Break examples:

```typescript
const breakMessages = [
  "You've been working for a while. How about a little break?",
  "Hey, stretch your legs for a minute, okay? ❤️",
  "A tiny break might do you good."
];
```

Hydration examples:

```typescript
const hydrationMessages = [
  "Hey! Have you had some water? 💧",
  "Quick check-in: water break?"
];
```

End-of-day examples:

```typescript
const endOfDayMessages = [
  "You've done enough for today. Want to call it a day? ❤️",
  "Okay, that's enough work for today. Take some time for yourself."
];
```

Do not add an LLM for message generation until deterministic behavior is validated.

---

# 21. LLM Policy

The MVP should not depend on an LLM.

Do not use an LLM to decide:

- whether the user should eat
- whether to interrupt
- whether the user is unhealthy
- whether the user has a medical issue
- whether the user is stressed
- whether the user is mentally unwell

If an LLM is introduced later, initially restrict it to low-risk language personalization.

Architecture:

```text
Activity
  ↓
Routine Learning
  ↓
Care Engine
  ↓
Decision
  ↓
Message context
  ↓
Optional LLM wording
  ↓
Care Card
```

Not:

```text
Activity
  ↓
LLM
  ↓
"Do whatever the model says"
```

---

# 22. Database Schema

At minimum, use:

## users

```sql
id UUID PRIMARY KEY
email VARCHAR
name VARCHAR
timezone VARCHAR
created_at TIMESTAMP
updated_at TIMESTAMP
```

## user_preferences

```sql
id UUID PRIMARY KEY
user_id UUID
work_start TIME
work_end TIME
lunch_enabled BOOLEAN
break_enabled BOOLEAN
hydration_enabled BOOLEAN
end_day_enabled BOOLEAN
persona VARCHAR
created_at TIMESTAMP
updated_at TIMESTAMP
```

## activity_sessions

```sql
id UUID PRIMARY KEY
user_id UUID
started_at TIMESTAMP
ended_at TIMESTAMP
active_seconds INTEGER
domain VARCHAR
created_at TIMESTAMP
```

## routine_patterns

```sql
id UUID PRIMARY KEY
user_id UUID
pattern_type VARCHAR
day_of_week INTEGER
start_time TIME
end_time TIME
confidence DECIMAL
sample_count INTEGER
updated_at TIMESTAMP
```

## interventions

```sql
id UUID PRIMARY KEY
user_id UUID
type VARCHAR
trigger VARCHAR
message TEXT
shown_at TIMESTAMP
response VARCHAR
responded_at TIMESTAMP
created_at TIMESTAMP
```

Use foreign keys and indexes appropriately.

Add indexes for:

- user_id
- timestamps
- intervention type
- routine pattern lookup

Do not create excessive indexes without evidence.

---

# 23. API

Initial endpoints:

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh

POST /api/activity/session
GET  /api/user/state

GET  /api/preferences
PUT  /api/preferences

GET  /api/routines
POST /api/routines/recalculate

POST /api/interventions
POST /api/interventions/:id/response
GET  /api/interventions/today

GET /health
```

Keep API contracts typed and shared where practical.

---

# 24. Authentication

Use a proven authentication provider or implementation.

Do not invent custom password handling.

If using Supabase:

- use Supabase Auth
- use PostgreSQL
- use Row Level Security where applicable

Never expose database credentials to the extension.

Never put secret API keys in the extension bundle.

---

# 25. Local Storage

The extension may use local storage for:

- authentication state where appropriate
- temporary activity buffer
- extension preferences
- notification state
- last synchronization timestamp

Do not store sensitive credentials or secrets insecurely.

Keep local data minimal.

---

# 26. Error Handling

The extension must continue functioning if the API is temporarily unavailable.

Example:

```text
API unavailable
    ↓
Store aggregated activity locally
    ↓
Retry later
```

Do not repeatedly retry aggressively.

Use exponential backoff where appropriate.

A backend outage should not break the basic extension experience.

---

# 27. Testing Requirements

Every core business rule must have unit tests.

At minimum test:

### Activity

- session creation
- session continuation
- session ending
- idle detection
- duplicate events
- timezone handling

### Routine learning

- insufficient observations
- normal observations
- outliers
- confidence calculation
- different weekdays

### Care Engine

- lunch intervention
- break intervention
- hydration intervention
- end-of-day intervention
- cooldown
- snooze
- dismissal
- paused user
- inactive user
- outside work hours
- overlapping intervention types

### API

- authentication
- activity submission
- intervention creation
- response recording
- authorization

Do not mark tests as passing without actually running them.

---

# 28. Timezone Handling

Never assume UTC for user-facing decisions.

Store timestamps consistently, preferably UTC.

Store the user's IANA timezone, for example:

```text
Asia/Kolkata
```

Convert to user-local time when evaluating:

- lunch window
- work hours
- end-of-day
- daily activity
- routine patterns

Write tests for timezone boundaries.

---

# 29. Analytics

Track product events without collecting private content.

Useful events:

```text
onboarding_started
onboarding_completed
activity_session_started
activity_session_completed
intervention_shown
intervention_confirmed
intervention_snoozed
intervention_dismissed
intervention_expired
jambu_paused
jambu_resumed
settings_changed
```

Do not send page contents or private user data to analytics.

---

# 30. Product Metrics

Primary:

**Meaningful intervention engagement**

Secondary:

- onboarding completion
- Day-1 retention
- Day-7 retention
- interventions/user/day
- confirmation rate
- snooze rate
- dismissal rate
- uninstall rate
- pause rate

A lower intervention count can be positive if it means Jambu has become better at timing.

Do not optimize simply for notification volume.

---

# 31. Security Requirements

Never:

- commit secrets
- expose database credentials
- expose server-side API keys in the extension
- store passwords yourself unless absolutely necessary
- log private content
- log authentication tokens
- send page content to the backend

Use environment variables for secrets.

Provide `.env.example`.

Add appropriate CORS restrictions.

Validate all API input.

Authenticate every user-specific endpoint.

Authorize every resource by user ID.

---

# 32. Coding Standards

Use:

- strict TypeScript
- explicit interfaces for public contracts
- small functions
- meaningful names
- no unnecessary abstraction
- no `any` unless justified
- async/await
- centralized error handling
- typed API responses

Prefer composition over large classes unless a class materially improves clarity.

Do not duplicate business logic between extension and API.

The backend is authoritative for persisted user state.

---

# 33. Code Quality Rules

Before declaring a task complete, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If one does not exist yet, create the appropriate script rather than silently skipping it.

Do not claim success if a command failed.

Fix TypeScript errors rather than suppressing them.

Avoid:

```typescript
// @ts-ignore
```

unless there is a documented, unavoidable reason.

---

# 34. Development Workflow

For every feature:

1. Understand the existing code.
2. Check the implementation plan.
3. Explain the intended changes briefly.
4. Implement the smallest complete change.
5. Add tests.
6. Run lint.
7. Run typecheck.
8. Run tests.
9. Run build.
10. Review the diff.
11. Update relevant documentation.
12. Report what changed.

Do not rewrite unrelated files.

Do not introduce new dependencies unless necessary.

Before adding a dependency, consider whether existing dependencies can solve the problem.

---

# 35. Git Workflow

Use feature branches.

Examples:

```text
feature/extension-foundation
feature/activity-tracking
feature/care-engine
feature/care-card
feature/routine-learning
feature/onboarding
```

Use small commits:

```text
feat: add activity session tracking
feat: add lunch care scoring
feat: add care card component
test: add lunch engine edge cases
fix: prevent duplicate interventions
```

Do not make giant unrelated commits.

---

# 36. Documentation Requirements

Maintain:

```text
docs/PRD.md
docs/ARCHITECTURE.md
docs/API.md
docs/IMPLEMENTATION_PLAN.md
```

When architecture changes materially, update the documentation.

When API contracts change, update API documentation.

When product behavior changes, update the PRD.

---

# 37. What NOT to Build

Unless explicitly requested, do not build:

- desktop application
- mobile application
- voice assistant
- AI chatbot
- wearable integration
- nutrition database
- calorie tracking
- medical recommendations
- medical diagnosis
- therapy features
- gamification
- social features
- team/company dashboards
- complex productivity analytics
- recommendation marketplace
- payment system
- subscription billing
- advanced AI agent

The MVP is intentionally narrow.

---

# 38. Future Roadmap

## Phase 2

Desktop companion:

```text
Chrome
+
Desktop
```

Possible signals:

- active application
- computer activity
- idle time
- screen lock/unlock
- work sessions

Still prioritize privacy.

## Phase 3

Personal rhythm model:

```text
work pattern
meal pattern
break pattern
response pattern
```

## Phase 4

Optional AI language personalization.

## Phase 5

Cross-platform personal care companion.

Do not prematurely implement future phases.

---

# 39. Design Principles

Every Jambu UI should feel:

- warm
- calm
- human
- simple
- trustworthy
- unobtrusive

Avoid:

- aggressive red warnings
- excessive charts
- productivity guilt
- streaks
- gamification
- clinical language
- notification overload

The emotional response we want is:

> **"Aww, Jambu is looking out for me."**

Not:

> **"Another app telling me what to do."**

---

# 40. Important Product Constraint

Jambu should never assume that its recommendation is universally correct.

For ordinary lifestyle nudges, use language such as:

- "Have you eaten?"
- "Want to take a short break?"
- "Have you had some water?"
- "Want to wrap up for today?"

Avoid authoritative health claims such as:

- "You must eat now."
- "You are dehydrated."
- "Your body needs..."
- "This is medically necessary."
- "You are unhealthy."

Jambu is a care companion, not a medical authority.

---

# 41. AI Coding Agent Behavior

When working on Jambu:

### Before coding

Inspect:

- existing repository structure
- package configuration
- existing docs
- current implementation
- tests

Do not overwrite working code blindly.

### Before architecture changes

Explain:

1. Why the change is needed.
2. What alternatives exist.
3. What files will change.
4. What risks exist.

Then implement unless explicit clarification is required.

### If requirements are ambiguous

Prefer the smallest implementation consistent with the existing PRD.

Do not invent large features.

### If you discover a problem

Tell the user clearly.

Do not hide:

- failing tests
- incomplete implementation
- security risks
- architectural compromises
- missing requirements

---

# 42. Definition of MVP Complete

The MVP is complete when:

- a user can install the Chrome extension
- onboarding takes less than approximately two minutes
- high-level activity is captured
- activity is aggregated
- data syncs to the backend
- user state can be derived
- lunch patterns can be learned
- Care Engine can make a deterministic decision
- care card can appear
- user can confirm
- user can snooze
- user can dismiss
- responses are stored
- cooldowns work
- routine learning works
- user can pause Jambu
- user can control intervention types
- user can delete their activity/account data
- privacy constraints are respected
- tests pass
- typecheck passes
- lint passes
- production build succeeds

Most importantly:

> **The complete "Mom Moment" loop must work reliably.**

---

# 43. Final Engineering Principle

When deciding between a more complicated implementation and a simpler implementation, prefer the simpler implementation **unless complexity directly improves the core experience**.

The first version of Jambu does not need to be extremely intelligent.

It needs to be:

**reliable + private + warm + well-timed.**

Build the smallest system capable of producing a genuinely caring moment.

---

# 44. Current Priority

If starting from an empty repository, work in this order:

```text
1. Repository foundation
2. Extension foundation
3. Backend foundation
4. Database
5. Authentication
6. Activity tracking
7. User state
8. Care Engine
9. Care Card
10. Intervention responses
11. Routine Learning
12. Onboarding
13. Settings/privacy
14. Analytics
15. Integration testing
16. Beta readiness
```

Do not skip directly to AI.

Do not build the desktop companion yet.

Do not optimize for scale before validating the core experience.

---

## North Star

Everything in Jambu should answer one question:

> **"Can we make the user's workday a little more human without becoming another thing they have to manage?"**
