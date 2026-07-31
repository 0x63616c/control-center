import type { ConsoleResponse } from "@/api/generated";

export type ConsoleState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: ConsoleResponse }
  | { kind: "refetch-error"; message: string; snapshot: ConsoleResponse };

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function ticketBlockers(ticket: NonNullable<ConsoleResponse["tickets"]>[number]) {
  if (ticket.state !== "open" || ticket.ready || !ticket.blockers?.length) return null;
  const failed = ticket.blockers.filter((blocker) => blocker.state === "failed");
  return (
    <div
      className={failed.length ? "console-blockers console-blockers-failed" : "console-blockers"}
      role={failed.length ? "alert" : undefined}
    >
      <p>
        {failed.length
          ? "A failed blocker will not unblock without human action."
          : "Waiting on Tickets:"}
      </p>
      <ul>
        {ticket.blockers.map((blocker) => (
          <li key={blocker.id}>
            <a href={`#ticket-${blocker.id}`}>
              Ticket {blocker.id}: {blocker.title}
            </a>{" "}
            <span className={`ticket-state ticket-state-${blocker.state}`}>{blocker.state}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Snapshot({
  snapshot,
  unconfirmedMessage,
}: {
  readonly snapshot: ConsoleResponse;
  readonly unconfirmedMessage?: string;
}) {
  const { factory, dispatcher } = snapshot;
  const tickets = snapshot.tickets ?? [];
  const inFlight = dispatcher.inFlight ?? [];
  const candidates = dispatcher.candidates ?? [];
  return (
    <>
      {(factory.paused || factory.breakerOpen || factory.configError) && (
        <section className="factory-alert" role="alert">
          {factory.paused && (
            <>
              <strong>Factory paused.</strong>{" "}
              {factory.pauseReason || "No new work will start until it is resumed."}
            </>
          )}
          {factory.breakerOpen && (
            <>
              <strong> Breaker tripped.</strong>{" "}
              {factory.breakerReason || "Dispatcher is temporarily holding work."} Clears at{" "}
              {factory.breakerOpenUntil}.
            </>
          )}
          {factory.configError && (
            <>
              <strong> Configuration rejected.</strong> {factory.configError}
            </>
          )}
        </section>
      )}
      {unconfirmedMessage && (
        <section className="factory-alert" role="alert">
          <strong>Refresh failed.</strong> Showing the last snapshot, which may no longer be
          current: {unconfirmedMessage}
        </section>
      )}
      <header className="console-header">
        <div>
          <h1>Software Factory</h1>
          <p>Read-only operational console</p>
        </div>
        <dl>
          <div>
            <dt>Factory</dt>
            <dd>{factory.paused ? "Paused" : "Running"}</dd>
          </div>
          <div>
            <dt>Max in flight</dt>
            <dd>{factory.maxInFlight}</dd>
          </div>
        </dl>
      </header>
      <main className="console-grid">
        <section aria-labelledby="in-flight-heading">
          <h2 id="in-flight-heading">In flight</h2>
          <p className="section-note">Legacy dispatcher Issues</p>
          {inFlight.length === 0 ? (
            <p>Nothing in flight.</p>
          ) : (
            <ol className="console-list">
              {inFlight.map((item) => (
                <li key={`${item.issueNumber}-${item.runID}`}>
                  <strong>Issue #{item.issueNumber}</strong>
                  <span>Run {item.runID}</span>
                  <span>Started {item.startedAt}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="next-heading">
          <h2 id="next-heading">Next</h2>
          <p>
            {dispatcher.freeSlots} free {dispatcher.freeSlots === 1 ? "slot" : "slots"} · last
            dispatcher write {age(dispatcher.ageSeconds)} ago
          </p>
          {dispatcher.stale && (
            <p className="stale" role="alert">
              Dispatcher state is stale. The next-work decision may no longer be current.
            </p>
          )}
          {candidates.length === 0 ? (
            <p>No eligible Issues queued by the dispatcher.</p>
          ) : (
            <ol className="console-list">
              {candidates.map((issueNumber) => (
                <li key={issueNumber}>Issue #{issueNumber}</li>
              ))}
            </ol>
          )}
        </section>
        <section className="console-worked" aria-labelledby="worked-heading">
          <h2 id="worked-heading">Worked</h2>
          <p className="section-note">Factory Tickets by recorded state</p>
          {tickets.length === 0 ? (
            <p>No Tickets have been recorded.</p>
          ) : (
            <ol className="console-list">
              {tickets.map((ticket) => (
                <li id={`ticket-${ticket.id}`} key={ticket.id}>
                  <strong>
                    Ticket {ticket.id}: {ticket.title}
                  </strong>
                  <span className={`ticket-state ticket-state-${ticket.state}`}>
                    {ticket.state}
                  </span>
                  {ticketBlockers(ticket)}
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </>
  );
}

export function Console({ state }: { readonly state: ConsoleState }) {
  switch (state.kind) {
    case "loading":
      return (
        <main>
          <p>Loading factory state…</p>
        </main>
      );
    case "error":
      return (
        <main>
          <p role="alert">Could not reach the factory API: {state.message}</p>
        </main>
      );
    case "ready":
      return <Snapshot snapshot={state.snapshot} />;
    case "refetch-error":
      return <Snapshot snapshot={state.snapshot} unconfirmedMessage={state.message} />;
  }
}
