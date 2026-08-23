# Account deletion TDD seams

P03 uses the machine-checkable acceptance criteria Calum approved in the App
Store release control document. Tests exercise only these public seams:

1. The authenticated HTTP boundary: `DELETE /api/me` accepts an explicit
   confirmation and an optional fresh Sign in with Apple authorization code,
   returns an opaque deletion request receipt, and immediately invalidates every
   session.
2. The real-Postgres `AccountDeletionStore` contract: request acceptance and
   local erasure preserve unrelated members while applying the approved
   active-member succession and personal-data erasure rules transactionally.
3. The external `AppleRevocationGateway`: tests replace only Apple's REST API,
   never product-owned stores or workflow logic.
4. `AccountDeletionWorkflow`: Temporal tests observe its public input, query,
   retry/terminal result, and activity outputs without asserting workflow
   internals.
5. The native `AppleSignIn` bridge: the untrusted Capacitor result must carry
   the actual authorization code through the typed frontend/API contract without
   logging it.

Raw SQL inventories are additional release evidence for the destructive-data
contract; they do not replace the HTTP/store/workflow behavior tests.
