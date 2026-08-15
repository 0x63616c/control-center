# There is one product; captive-portal becomes the guest-wifi App

> **Partially superseded by [ADR-0013](./0013-dont-text-your-ex-colocated-independent-product.md).**
> The captive-portal fold remains in force. The later, explicitly requested
> Don’t Text Your Ex restoration supersedes only the repository-wide claim that
> there can be no second colocated Product.

The `captive-portal` product dissolves into `control-center`. There is one Product going forward.
The guest surface — today an entire separate product with its own cluster, database, and DNS
name — becomes a portal-only guest listener inside the control-center API image: a second HTTP
listener on its own port, mounting only the portal router and the guest static bundle, nothing
else the main API exposes. The guest web frontend becomes a second Vite entrypoint built on the
shared control-center UI primitives, not a separate app skeleton.

Both products collapse onto the single control-center Postgres database (`control_center`). The
captive-portal cluster and its migration tooling delete outright — **the split's cutover to a
separate database was never approved**; control-center remained the source of truth for guest data
throughout, so this is not a migration so much as a formal recognition that the second cluster
never did the job it was built for.

Hostnames simplify accordingly: the guest surface serves from `app.worldwidewebb.co`. The
`${host}--${dnsCode}` hostname-flattening scheme and the `dnsCode` concept it depended on delete
entirely — they existed to route between two products' DNS names and have no referent once there
is one. `dashboard.worldwidewebb.co` retires.

The repo flattens: `products/` as a directory layer dies. Today's one remaining product,
control-center, moves up; any future product gets its own repo rather than a new sibling under
`products/`.

## Why (the trade-off)

The alternative was to keep captive-portal as a real second product — its own deploy unit,
database, and DNS name — on the theory that guest wifi is naturally a separate surface with its
own trust boundary. In practice every mechanism built to support that plurality
(`products/`, the dnsCode hostname flattening, the second Postgres cluster and its migration
tooling) had exactly **one** real inhabitant: control-center. A repo layer, a hostname scheme, and
a database cluster built for N products but used by 1 is overhead with no payoff; a portal-only
listener inside the existing API gets the same trust-boundary isolation (guest traffic only ever
reaches the portal router) without any of the duplicated infrastructure.

## Supersedes

This ADR supersedes the multi-product framing in `docs/platform/README.html` and
`NORTH_STAR.html`, both of which describe control-center and captive-portal as sibling products.
Those documents should carry a superseded-by-ADR-0006 banner note now; deleting them outright is
Task 8's job.

## Why it is recorded

Hard to reverse — this deletes a product (its image, CI job, infra workload, and namespace), a
whole Postgres cluster and its migration tooling, two DNS names, and the `products/` path layer
that every other product folder assumed existed. None of that comes back cheaply once removed.

Surprising without context — a reader who finds `NORTH_STAR.html` and `docs/platform/README.html`
describing two products, plus the `${host}--${dnsCode}` hostname scheme, will reasonably expect a
live second product and will not know it was folded away and why.

A real trade-off — in-repo product plurality (a `products/` directory holding several deploy
units, each with its own database and hostname scheme) versus one product per repo. It is decided
here by direct evidence rather than by taste: every mechanism that existed to support more than one
product in this repo had exactly one real user, so the plurality machinery is deleted rather than
kept "for when it's needed."
