import { useCallback, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrototypeSwitcher, type PrototypeVariant } from "@/components/PrototypeSwitcher";

// PROTOTYPE — Three create-Ticket concepts on one throwaway route, switchable
// with ?variant=. No API mutation is made; Create only surfaces in-memory state.

type Draft = {
  readonly title: string;
  readonly body: string;
};

type Submission =
  | { readonly kind: "editing" }
  | { readonly kind: "created"; readonly draft: Draft };

type VariantProps = {
  readonly draft: Draft;
  readonly submission: Submission;
  readonly onTitleChange: (title: string) => void;
  readonly onBodyChange: (body: string) => void;
  readonly onCreate: () => void;
};

function variantFromSearch(): PrototypeVariant {
  const variant = new URLSearchParams(window.location.search).get("variant");
  return variant === "B" || variant === "C" ? variant : "A";
}

function MarkdownPreview({ body }: { readonly body: string }) {
  return (
    <div className="ticket-body prototype-markdown">
      {body.trim() ? (
        <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
      ) : (
        <p className="prototype-placeholder">Your rendered Markdown will appear here.</p>
      )}
    </div>
  );
}

function CreateButton({ draft, onCreate }: Pick<VariantProps, "draft" | "onCreate">) {
  return (
    <button
      className="prototype-primary"
      type="button"
      disabled={!draft.title.trim() || !draft.body.trim()}
      onClick={onCreate}
    >
      Create ticket
    </button>
  );
}

function CreatedNotice({ submission }: { readonly submission: Submission }) {
  if (submission.kind !== "created") return null;
  return (
    <div className="prototype-created" role="status">
      <strong>Prototype complete.</strong> “{submission.draft.title}” would be created now. No
      ticket was filed.
    </div>
  );
}

function VariantA(props: VariantProps) {
  return (
    <main className="prototype-page prototype-a">
      <header className="prototype-page-head">
        <div>
          <span className="prototype-kicker">New ticket</span>
          <h1>Turn an idea into work</h1>
          <p>Write on the left. Check exactly what the factory receives on the right.</p>
        </div>
        <CreateButton draft={props.draft} onCreate={props.onCreate} />
      </header>
      <CreatedNotice submission={props.submission} />
      <div className="prototype-split">
        <section className="prototype-panel">
          <label htmlFor="title-a">Title</label>
          <input
            id="title-a"
            value={props.draft.title}
            onChange={(event) => props.onTitleChange(event.target.value)}
            placeholder="A crisp description of the outcome"
          />
          <div className="prototype-field-head">
            <label htmlFor="body-a">Body</label>
            <span>Markdown</span>
          </div>
          <textarea
            id="body-a"
            value={props.draft.body}
            onChange={(event) => props.onBodyChange(event.target.value)}
            placeholder={"## What should change\n\nDescribe the outcome and constraints…"}
          />
        </section>
        <section className="prototype-panel prototype-preview-panel" aria-label="Markdown preview">
          <span className="prototype-label">Preview</span>
          <h2>{props.draft.title || "Untitled ticket"}</h2>
          <MarkdownPreview body={props.draft.body} />
        </section>
      </div>
    </main>
  );
}

function VariantB(props: VariantProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  return (
    <main className="prototype-page prototype-b">
      <div className="prototype-console-context" aria-hidden="true">
        <div>
          <h2>Tickets</h2>
          <p>Every factory Ticket, newest first</p>
        </div>
        <button type="button">+ New ticket</button>
      </div>
      <div className="prototype-scrim" />
      <section className="prototype-dialog" aria-label="Create ticket dialog">
        <header>
          <div>
            <span className="prototype-kicker">Create ticket</span>
            <h1>What needs doing?</h1>
          </div>
          <a href="#/" aria-label="Close">
            ×
          </a>
        </header>
        <CreatedNotice submission={props.submission} />
        <label htmlFor="title-b">Title</label>
        <input
          id="title-b"
          value={props.draft.title}
          onChange={(event) => props.onTitleChange(event.target.value)}
          placeholder="Ticket title"
        />
        <div className="prototype-tabs" role="tablist" aria-label="Ticket body view">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "write"}
            onClick={() => setMode("write")}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </button>
          <span>Markdown supported</span>
        </div>
        {mode === "write" ? (
          <textarea
            id="body-b"
            aria-label="Body"
            value={props.draft.body}
            onChange={(event) => props.onBodyChange(event.target.value)}
            placeholder="Describe the work, constraints, and definition of done…"
          />
        ) : (
          <MarkdownPreview body={props.draft.body} />
        )}
        <footer>
          <span>⌘ Enter to create</span>
          <div>
            <a className="prototype-secondary" href="#/">
              Cancel
            </a>
            <CreateButton draft={props.draft} onCreate={props.onCreate} />
          </div>
        </footer>
      </section>
    </main>
  );
}

function VariantC(props: VariantProps) {
  const [previewOpen, setPreviewOpen] = useState(true);
  return (
    <main className="prototype-page prototype-c">
      <section className="prototype-composer">
        <span className="prototype-kicker">Quick create</span>
        <input
          aria-label="Title"
          className="prototype-title-plain"
          value={props.draft.title}
          onChange={(event) => props.onTitleChange(event.target.value)}
          placeholder="Give the ticket a title…"
        />
        <textarea
          aria-label="Body"
          className="prototype-body-plain"
          value={props.draft.body}
          onChange={(event) => props.onBodyChange(event.target.value)}
          placeholder="Write the body in Markdown…"
        />
        <div className="prototype-composer-actions">
          <button
            className="prototype-preview-toggle"
            type="button"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            {previewOpen ? "Hide preview" : "Show preview"}
          </button>
          <span>{props.draft.body.length} characters</span>
          <CreateButton draft={props.draft} onCreate={props.onCreate} />
        </div>
      </section>
      <CreatedNotice submission={props.submission} />
      {previewOpen && (
        <section className="prototype-inline-preview" aria-label="Markdown preview">
          <header>
            <span className="prototype-label">Ticket preview</span>
            <span className="pill pill-open">open</span>
          </header>
          <h1>{props.draft.title || "Untitled ticket"}</h1>
          <MarkdownPreview body={props.draft.body} />
        </section>
      )}
    </main>
  );
}

export function CreateTicketPrototype() {
  const [variant, setVariant] = useState<PrototypeVariant>(variantFromSearch);
  const [draft, setDraft] = useState<Draft>({ title: "", body: "" });
  const [submission, setSubmission] = useState<Submission>({ kind: "editing" });

  const onVariantChange = useCallback((next: PrototypeVariant) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
    setVariant(next);
  }, []);

  const props: VariantProps = {
    draft,
    submission,
    onTitleChange: (title) => {
      setDraft((current) => ({ ...current, title }));
      setSubmission({ kind: "editing" });
    },
    onBodyChange: (body) => {
      setDraft((current) => ({ ...current, body }));
      setSubmission({ kind: "editing" });
    },
    onCreate: () => setSubmission({ kind: "created", draft }),
  };

  return (
    <>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      <PrototypeSwitcher current={variant} onChange={onVariantChange} />
    </>
  );
}
