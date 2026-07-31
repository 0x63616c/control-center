import type { TicketSummary } from "@/api/generated";
import { RunList } from "@/features/ticket-detail/RunList";
import type { TicketDetailState } from "@/features/ticket-detail/useTicketDetail";

// Presentational only, driven by the discriminated union useTicketDetail
// produces — Storybook and tests exercise every state without a network.
export function TicketDetail({ state }: { state: TicketDetailState }) {
  switch (state.kind) {
    case "loading":
      return <p data-testid="ticket-detail">Loading ticket…</p>;
    case "error":
      return (
        <p data-testid="ticket-detail" role="alert">
          Could not reach the API: {state.message}
        </p>
      );
    case "ready":
      return (
        <article data-testid="ticket-detail">
          <header>
            <h1>
              #{state.ticket.id} {state.ticket.title}
            </h1>
            <p>
              <strong>{state.ticket.state}</strong>
              {state.ticket.state === "open" && (state.ticket.ready ? " · ready" : " · blocked")}
            </p>
          </header>
          <p>{state.ticket.body}</p>
          <DependencyList title="Blocked by" tickets={state.ticket.blockers} />
          <DependencyList title="Blocks" tickets={state.ticket.blocks} />
          <section>
            <h2>Runs</h2>
            <RunList runs={state.runs} />
          </section>
        </article>
      );
  }
}

function DependencyList({ title, tickets }: { title: string; tickets: TicketSummary[] | null }) {
  const list = tickets ?? [];
  if (list.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {list.map((ticket) => (
          <li key={ticket.id}>
            #{ticket.id} {ticket.title} — {ticket.state}
            {ticket.state === "open" && (ticket.ready ? " (ready)" : " (blocked)")}
          </li>
        ))}
      </ul>
    </section>
  );
}
