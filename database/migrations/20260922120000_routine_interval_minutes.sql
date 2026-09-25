-- Decision D77 — routine_patterns gains a numeric interval column.
--
-- P7 read a break interval as the span between `start_time` and `end_time`,
-- because that was the only reading available without a migration. It was
-- always a lie about what those columns mean: "90 minutes" stored as
-- 00:00-01:30 is not a time of day, and the encoding cannot express an
-- interval of 24 hours or more.
--
-- P11 owns the routine-learning data model, so this is the moment to fix it
-- rather than inherit it. A break interval is a duration, and now it is stored
-- as one.
alter table public.routine_patterns
  add column interval_minutes integer;

comment on column public.routine_patterns.interval_minutes is
  'Duration in minutes for interval-shaped patterns such as break_interval. NULL for time-of-day patterns (lunch, work_start, work_end).';

-- A pattern is either a time of day or a duration, never both and never
-- neither. This is what stops the P7 encoding from creeping back.
alter table public.routine_patterns
  add constraint routine_patterns_shape_is_coherent
  check (
    (pattern_type = 'break_interval'
       and interval_minutes is not null
       and start_time is null
       and end_time is null)
    or
    (pattern_type <> 'break_interval'
       and interval_minutes is null)
  );

alter table public.routine_patterns
  add constraint routine_patterns_interval_minutes_positive
  check (interval_minutes is null or interval_minutes > 0);
