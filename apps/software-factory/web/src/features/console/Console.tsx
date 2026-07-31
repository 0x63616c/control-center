import type { ConsoleResponse } from "@/api/generated";

export type ConsoleState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: ConsoleResponse }
  | { kind: "refetch-error"; message: string; snapshot: ConsoleResponse };

function Snapshot({
  snapshot,
  unconfirmedMessage,
}: {
  readonly snapshot: ConsoleResponse;
  readonly unconfirmedMessage?: string;
}) {
  const tickets = snapshot.tickets ?? [];
  return (
    <>
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
      </header>
      <main className="console-grid">
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
                    <a href={`#/tickets/${ticket.id}`}>
                      Ticket {ticket.id}: {ticket.title}
                    </a>
                  </strong>
                  <span className={`ticket-state ticket-state-${ticket.state}`}>
                    {ticket.state}
                  </span>
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
