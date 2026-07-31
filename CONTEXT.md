# World Wide Webb

World Wide Webb includes a software factory that turns its own durable work
requests into reviewed changes while keeping an inspectable execution history.

## Software factory language

**Ticket**:
A unit of requested work owned by the software factory and stored in its own
database.
_Avoid_: Issue, GitHub issue

**Run**:
One attempt to complete a whole Ticket, represented by one Temporal workflow
execution.
_Avoid_: Job, session

**Step**:
One independently attempted and retried unit of workflow work inside a Run. A
Step has exactly one primary operation whose executions are its Attempts.
_Avoid_: Phase, every Temporal activity

**Attempt**:
One execution of a Step's primary operation for identical logical work.
_Avoid_: Turn, semantic rework

**Agent Stage**:
The kind of agent work performed by an agent-backed Step: `plan`, `implement`,
or `review`.
_Avoid_: Step, phase
