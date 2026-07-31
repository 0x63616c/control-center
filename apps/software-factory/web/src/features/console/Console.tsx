import { Fragment } from "react";
import type { ConsoleResponse } from "@/api/generated";
import { StatePill, ticketStatus } from "@/components/StatePill";

export type ConsoleState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: ConsoleResponse }
  | { kind: "refetch-error"; message: string; snapshot: ConsoleResponse };

type Ticket = NonNullable<ConsoleResponse["tickets"]>[number];

function age(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// updatedAgo renders a Ticket's last update as a short age against now. The
// console refetches on an interval, so "now" moving between renders is the
// intended behavior here, unlike duration.ts's completed-span rule.
function updatedAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 86_400) return `${age(seconds)} ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// The state the machine is actively responsible for comes first; terminal
// states last, so the top of the board is always the live work.
const STATE_ORDER: Record<string, number> = {
  working: 0,
  review: 1,
  ready: 2,
  blocked: 3,
  failed: 4,
  done: 5,
};

function ticketBlockers(ticket: Ticket) {
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
              #{blocker.id} {blocker.title}
            </a>{" "}
            <StatePill ticket={blocker} />
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
  const tickets = [...(snapshot.tickets ?? [])].sort(
    (a, b) => (STATE_ORDER[ticketStatus(a)] ?? 9) - (STATE_ORDER[ticketStatus(b)] ?? 9),
  );
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
        <h1>The Software Factory</h1>
        <span className={factory.paused ? "pill pill-blocked" : "pill pill-done"}>
          {factory.paused ? "Paused" : "Running"}
        </span>
      </header>
      <main className="console-grid">
        <section aria-labelledby="in-flight-heading">
          <h2 id="in-flight-heading">In flight</h2>
          <p className="section-note">Legacy dispatcher Issues</p>
          {inFlight.length === 0 ? (
            <p className="section-empty">Nothing in flight.</p>
          ) : (
            <ol className="console-list">
              {inFlight.map((item) => (
                <li key={`${item.issueNumber}-${item.runID}`}>
                  <div className="row-line">
                    <strong>Issue #{item.issueNumber}</strong>
                    <span className="pill pill-working">running</span>
                  </div>
                  <span className="row-meta">
                    Run {item.runID} · started {item.startedAt}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="next-heading">
          <h2 id="next-heading">Next</h2>
          <p className="section-note">
            {dispatcher.freeSlots} free {dispatcher.freeSlots === 1 ? "slot" : "slots"} · last
            dispatcher write {age(dispatcher.ageSeconds)} ago
          </p>
          {dispatcher.stale && (
            <p className="stale" role="alert">
              Dispatcher state is stale. The next-work decision may no longer be current.
            </p>
          )}
          {candidates.length === 0 ? (
            <p className="section-empty">No eligible Issues queued by the dispatcher.</p>
          ) : (
            <ol className="console-list">
              {candidates.map((issueNumber) => (
                <li key={issueNumber}>
                  <div className="row-line">
                    <strong>Issue #{issueNumber}</strong>
                    <span className="pill pill-open">queued</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="console-tickets" aria-labelledby="tickets-heading">
          <h2 id="tickets-heading">Tickets</h2>
          <p className="section-note">Every factory Ticket, live work first</p>
          {tickets.length === 0 ? (
            <p className="section-empty">No Tickets have been recorded.</p>
          ) : (
            <table className="ticket-table">
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">State</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => {
                  const blockers = ticketBlockers(ticket);
                  return (
                    <Fragment key={ticket.id}>
                      <tr id={`ticket-${ticket.id}`}>
                        <td>
                          <a href={`#/tickets/${ticket.id}`}>
                            #{ticket.id} {ticket.title}
                          </a>
                        </td>
                        <td>
                          <StatePill ticket={ticket} />
                        </td>
                        <td className="row-meta">{updatedAgo(ticket.updatedAt)}</td>
                      </tr>
                      {blockers && (
                        <tr className="ticket-table-blockers">
                          <td colSpan={3}>{blockers}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
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
