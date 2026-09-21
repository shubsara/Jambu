# Jambu

**A little digital companion that looks out for you while you work.**

Jambu quietly observes high-level work patterns, learns your routine, and
offers small, warm check-ins when you may have forgotten to look after
yourself.

> 👩 Hey! ❤️
>
> Have you taken your lunch?
>
> `[ Yes, I have ]`  `[ Remind me later ]`
>
> — Mom ❤️

Jambu is **not** a reminder app, a to-do list, a productivity tracker, a
chatbot, or a medical app. It is built around one principle:

> **Jambu should know when to care — and when not to interrupt.**

---

## Status

**Pre-alpha — in development.** Not yet installable. The MVP is being built in
phases; see [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

---

## How it works

```text
Your activity  →  Aggregated sessions  →  Routine learning
                                                  ↓
                                            Care Engine
                                                  ↓
                                    "Should we say something?"
                                                  ↓
                                            Care Card  →  Your response
                                                                ↓
                                                   Jambu gets better at timing
```

The **Care Engine** decides *whether* to speak. A separate message layer
decides *how to say it*. Both are deterministic — there is no LLM anywhere in
the decision path.

Jambu is comfortable doing nothing. A notification is an intervention, not the
default behaviour.

---

## Privacy

**Jambu knows how long you have been working — not what you are working on.**

| Collected | Never collected |
|---|---|
| Active browser state | Keystrokes |
| Active **domain** (never the full URL) | Page contents |
| Timestamps and session duration | Passwords or credentials |
| Idle state | Email or private messages |
| Intervention history | Form inputs |
| Your preferences and routine statistics | Screenshots or clipboard |

Activity is **aggregated**, never stored as a raw event stream. A stored
session looks like this — and nothing more:

```json
{ "domain": "notion.so", "startedAt": "...", "endedAt": "...", "activeSeconds": 2100 }
```

You can pause Jambu at any time, disable any reminder type, export everything
Jambu holds about you, and delete your activity or your entire account.

These constraints are enforced by automated tests that fail the build, not by
a policy document.

---

## MVP scope

Four gentle check-ins: **lunch · break · hydration · end of workday.**

Hydration is off by default and opt-in. Jambu asks questions
("Have you had some water?") and never makes medical claims.

---

## Architecture

| Component | Stack |
|---|---|
| Chrome extension | React · TypeScript · Manifest V3 · Tailwind |
| API | Node.js · TypeScript · Fastify |
| Database & auth | Supabase (PostgreSQL + Auth) |
| Care Engine | Pure, deterministic TypeScript package |
| Routine learning | Pure, deterministic TypeScript package |
| Tooling | pnpm workspaces · Vitest |

```text
jambu/
├── apps/         extension · api
├── packages/     care-engine · routine-learning · shared-types · message-templates
├── database/     migrations · seed
└── docs/         PRD · ARCHITECTURE · API · IMPLEMENTATION_PLAN
```

The Care Engine holds no UI logic and the extension holds no authoritative
decision logic. The extension never talks to the database directly.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | Build phases, decisions, risks |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, database schema, permissions |
| [`docs/API.md`](docs/API.md) | Endpoint contracts |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements |

`CLAUDE.md` in the repository root is the **internal instruction file for the
Claude Code agent**, not project documentation. Please don't copy it into this
README.

---

## Development

Requires Node.js, pnpm, and a Supabase project.

```bash
pnpm install
cp .env.example .env    # then fill in your Supabase values
pnpm dev
```

Before any change is considered complete:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Secrets live in `.env` and are never committed. The Supabase service-role key
is used **server-side only** and never reaches the extension bundle.

---

## What Jambu will not become

No desktop or mobile app, no voice assistant, no chatbot, no wearables, no
calorie tracking, no medical advice, no gamification or streaks, no social
features, no team dashboards, no productivity analytics.

The emotional response we want is *"Aww, Jambu is looking out for me"* — not
*"Another app telling me what to do."*
