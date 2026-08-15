# Don’t Text Your Ex is a colocated, independently deployed Product

Don’t Text Your Ex is restored at `apps/dont-text-your-ex` as a second Product
in this repository. It is independently built and deployed with its own images,
`dont-text-your-ex` Kubernetes namespace, CNPG database, backup, public
`dont-text-your-ex.worldwidewebb.co` host, and preserved Apple identity
`co.worldwidewebb.textyourex`.

This is a narrow exception to ADR-0006's rule that any future Product belongs in
its own repository. It also supersedes ADR-0006's statement that there is one
Product going forward, but it does not reverse the decision to fold
`captive-portal` into Control Center's `guest-wifi` App.

## Why colocate it

The requested recovery source is the last monorepo version at commit
`486a0ebbc`, and the requested target is explicitly `apps/dont-text-your-ex`.
Keeping it here preserves that history while letting the existing repository
CI, image publishing, Pulumi deployment, secret handling, and production
verification machinery carry the restoration. Splitting repositories during a
recovery would add a migration and release-system cutover unrelated to restoring
the application.

The earlier multi-product `products/` abstraction does not return. `apps/`
already means deployable processes in the current layout, so this Product lives
there directly and owns its nested frontend, API, end-to-end suite, native iOS
shell, and release automation. It does not register as a Control Center
`features/<id>` App and does not share Control Center's database or namespace.

## Consequences

- The repository contains two Products: Control Center and Don’t Text Your Ex.
  "Single-product" descriptions elsewhere remain accurate only for Control
  Center's flattened internal architecture, not for the repository-wide deploy
  count.
- Don’t Text Your Ex remains an explicit exception, not a precedent for a new
  generic product framework. Another Product still defaults to its own
  repository unless a later ADR records why colocation is the smaller choice.
- Shared repository quality gates may be reused, but deployment, persistence,
  routing, and Apple release evidence must remain independently attributable to
  Don’t Text Your Ex.

## Supersedes

This ADR supersedes only ADR-0006's repository-wide claims that there is one
Product going forward and that every future Product must use another repository.
All other ADR-0006 decisions remain in force.
