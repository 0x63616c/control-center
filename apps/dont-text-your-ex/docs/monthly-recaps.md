# Monthly recap metric contract

Monthly recaps are immutable snapshots for one completed calendar month in the
jar's immutable IANA timezone. PostgreSQL derives both month boundaries with
`AT TIME ZONE`; the elapsed milliseconds may therefore include a daylight-saving
hour rather than assuming every day is 24 hours.

The snapshot metrics have these fixed meanings:

- **Slip count** counts persisted `slips` whose `created_at` is greater than or
  equal to the local month start and strictly less than the next local month.
- **Total amount** sums `amount_cents` over exactly those slips.
- **Tally change** is that same persisted slip sum. There is no separate tally
  history in the product, so the recap does not infer a starting balance or
  invent a comparison with an unavailable prior snapshot.
- **Shared streak highlights** count only the already-public milestone activity
  rows emitted when streak sharing was enabled. The query never reads private
  streak state, user names, or membership identity into the snapshot.
- **Crossed jar milestones** are the persisted `jar_milestones.threshold_cents`
  values whose `reached_at` falls inside the same half-open month interval.

An open or closed jar is eligible only when it has at least one persisted
activity row in the month. A recipient row is created only for someone who is a
current member at generation time and whose membership tenure overlapped the
month. Every read repeats the current-membership check, so leaving immediately
removes access without mutating the snapshot.

Missing source data produces an empty list or zero. The API and UI never
calculate a trend, percentage, or previous-month comparison from missing data.
