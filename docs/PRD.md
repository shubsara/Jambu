# Jambu — Product Requirements

**Status:** Onboarding requirements written out in P12 (decision D94). The
remaining sections are listed in §7.

`CLAUDE.md` is the authoritative product specification today. This document
will carry the product requirements in a form suitable for people who are not
the engineering agent, and must be updated whenever product behaviour changes
(`CLAUDE.md` §36).

---

## 1. Problem

People who work long stretches at a laptop routinely forget to eat, drink,
stand up, or stop for the day. Existing tools nag on a schedule, which is why
people turn them off.

## 2. Product principle

> Jambu should know when to care — and when not to interrupt.

Jambu must be comfortable doing nothing. A notification is an intervention,
not the default behaviour (`CLAUDE.md` §3.1).

## 3. MVP scope

Four interventions: lunch, break, hydration, end of workday (`CLAUDE.md` §2).
Hydration is opt-in and off by default (decision D7).

## 4. First milestone

The "Mom Moment" — the complete loop from observed activity to a care card the
user responds to, described in `CLAUDE.md` §5 and built through phase P10.

## 5. Success measure

Primary: meaningful intervention engagement. A *lower* intervention count is a
positive signal when it means Jambu's timing improved (`CLAUDE.md` §30).

## 6. Onboarding requirements (P12, decision D94)

### What onboarding is for

To get someone from "just installed" to "Jambu is looking out for me" in under
two minutes, while asking for as little as possible. Onboarding is also where
Jambu earns permission to observe: activity tracking does not begin until the
flow is finished (D93). Signing in is not consent; finishing is.

### The flow

Four steps, opened in their own tab on install (D85):

1. **Hello** — what Jambu does, and the privacy promise stated up front: it
   notices *how long* you have been working, never *what* you are working on.
2. **Your account** — email and password. These are the only two things the
   user must type (D95).
3. **Where are you?** — the timezone, pre-filled from the browser and
   changeable (D90).
4. **What should I check in about?** — lunch, breaks, water, end of day. All
   pre-set; water is off (D7, D89).

### What onboarding must never ask

Lunch time, water schedule, break schedule, **work hours**, persona, or the
user's name. `CLAUDE.md` §3.2 forbids making the user schedule their own care,
and P11 learns work hours, lunch and break rhythm from behaviour anyway (D84,
D88). Work hours keep a 09:00-18:00 default (D91) until learning replaces it.
The user's name is not collected because nothing uses it (A6).

This is enforced by the shape of `OnboardingState` and `OnboardingSubmission`,
which have no field for any of it — a rendered-text scan is only the second
line of defence.

### Skipping

Skipping is offered on every step and costs the user nothing (D92). A user who
skips keeps a working account and popup and can resume later from where they
stopped — and Jambu watches nothing at all until they do (A5).

### Success criteria

- Under two minutes: at most five steps and five required inputs (D95).
- A user who clicks straight through gets sensible defaults and no water
  reminders.
- Nothing is tracked before the flow is finished.

## 7. Control and privacy (P13, decisions D97-D107)

### Three separate promises

Jambu makes three distinct promises about control, and each has its own
control. They are deliberately not collapsed into one switch:

| Promise | Control | Decision |
|---|---|---|
| "You decide whether I watch at all." | Onboarding consent | D93 |
| "You decide whether I speak right now." | Pause | D99 |
| "You decide what I keep." | Export and deletion | D105-D107 |

**Pause silences, it does not blind.** A paused Jambu says nothing — no cards,
and any card already on screen is taken away (D100) — but it keeps observing,
so resuming does not start from nothing. Someone who wants to stop being
observed has a different control, and someone who wants what was observed
removed has a third.

### Pause

Offered for 30 minutes, 1 hour, 2 hours, or the rest of the day (D98). "Rest
of day" means the user's work-end, learned where Jambu has learned it (D101).

### Snooze

A snooze is something the user earns by answering a card with "remind me
later" — a reaction to a moment, not a schedule. Settings shows active
snoozes and can clear them, but never creates one (D102), because asking
people to schedule their own care is the thing §3.2 exists to prevent.

Turning an intervention type off clears its snooze: the stronger, more
deliberate choice replaces the weaker temporary one (D103).

### Export and deletion

Export is a versioned JSON download the user can read (D105). It contains no
URL and no page content, because Jambu never collected any.

Deleting activity keeps the account; deleting the account removes everything
and leaves only an audit row holding an opaque id and two timestamps. Both are
irreversible, both require the user to **type** the confirmation (D106), and
both run asynchronously with a status the UI can poll rather than assume
(D104). After account deletion the extension signs out, forgets its
credentials and onboarding state, and says plainly that it is done (D107).

## 8. To be written

- [ ] User personas and the problem in their words
- [ ] Intervention copy guidelines beyond `CLAUDE.md` §20
- [ ] Private beta success criteria
- [ ] Non-goals, expanded from `CLAUDE.md` §37
