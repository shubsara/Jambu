# Jambu — Product Requirements

**Status:** Stub created in P0. To be written out before P12 (onboarding), when
product behaviour first becomes user-visible beyond the Mom Moment.

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

## 6. To be written

- [ ] User personas and the problem in their words
- [ ] Onboarding requirements in detail (feeds P12)
- [ ] Intervention copy guidelines beyond `CLAUDE.md` §20
- [ ] Private beta success criteria
- [ ] Non-goals, expanded from `CLAUDE.md` §37
