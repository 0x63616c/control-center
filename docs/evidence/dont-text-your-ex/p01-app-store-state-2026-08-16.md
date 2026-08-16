# Don’t Text Your Ex P01 App Store state — 2026-08-16

Observed in the signed-in App Store Connect UI for Apple app `6778544752` on
2026-08-16. The name change described below was explicitly authorized by the
owner’s earlier product-name instruction. All other observations were read-only.
No credentials, private contacts, tester identities, or secret values were read
or recorded.

## Name change

```text
before=Don’t Text Your Ex Together
requested=Don’t Text Your Ex
after=Don’t Text Your Ex
App Store Connect status=Saved
locale=English (U.S.)
characters remaining=12
```

The coordinator captured `/tmp/dtye-p01-app-name-saved.png` outside version
control. Independent original-resolution review confirmed that the image clearly
shows `App Information`, the exact Name value, and the checked `Saved` state.
No PII or secrets were visible. The screenshot was not committed because it also
contains unnecessary administrative identifiers and its cached top breadcrumb
still truncates the previous name; the editable field plus `Saved` state is the
accepted proof boundary.

## Current app-level state

```text
Bundle ID=co.worldwidewebb.textyourex
Primary language=English (U.S.)
Subtitle=blank
Content Rights=not set up
License agreement=Apple Standard License Agreement
Primary category=unset
Secondary category=unset
Age rating=not set up
DSA=current developer declaration is non-trader for this app
```

The DSA value is current external state, not a new owner attestation. Calum must
explicitly confirm it remains accurate before P01 can close.

## Current commerce and availability state

```text
Price schedule=unset; Add Pricing shown
App availability/storefronts=unset; Set Up Availability shown
Tax category=App Store software
Distribution method=Public — Discoverable by anyone on the App Store
Apple School Manager reduced-price option=checked
Apple-silicon Mac availability=checked; minimum macOS Automatic (11.0)
Apple Vision Pro availability=checked
Apple Vision Pro compatibility=Version 1.0 is not compatible and not available
```

No commerce, storefront, Mac, Vision Pro, School Manager, or distribution value
was changed during this inspection. These current values require an explicit P01
disposition rather than being silently inherited.

## Current privacy state

```text
Privacy Policy URL=unset
User Privacy Choices URL=unset
App Privacy questionnaire=not started; Get Started shown
Publish=disabled
```

This proves setup state only. It does not answer the eventual data-collection
questions; P09 owns the audited data inventory and P14 owns the final published
App Privacy answers.

