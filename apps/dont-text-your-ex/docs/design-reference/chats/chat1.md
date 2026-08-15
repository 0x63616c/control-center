# Ex-Blocking App

_Started 2026-06-08 03:50 UTC_

---

## User

<system-info comment="Only acknowledge these if relevant">
Project title is now "text-your-ex"
Project is currently empty (no files)
Current date is now June 7, 2026
</system-info>

<pasted_text name="Pasted text (143 lines)">
Text Your Ex - Product Spec

Date: 2026-06-07 Status: Draft for review Author: Calum + Claude

1. The Pitch

A group accountability app for one very specific failure mode: texting your ex.

You and your friends know who shouldn't be texting whom. So you make a pact, throw your slip-ups into a shared jar, and watch the guilt money pile up. Every time someone caves and texts their ex, it gets logged. The tally grows. Your friends find out. Shame, but make it a leaderboard.

The name is the joke, said straight: Text Your Ex - an app you open instead of texting your ex. You log the urge (or the slip) here rather than sending the message you'll regret.

One-line: A shared guilt jar for friends trying not to text their exes.

2. Core Concepts

Concept	What it is
Jar	A named accountability group. Has members, a rule, and a running tally/pot. (Playful alt-name: "a Jaw." Functionally identical - rename is a config flag.)
Slip	One logged incident of texting your ex. Has a $ amount, timestamp, optional note, and the person it's attributed to.
Tally	The running total. Per-person and per-jar. The scoreboard.
Report	When a member flags another member for a slip they didn't self-log. Goes to the accused to confirm or deny.
Settle up	Inert button in v1. Shows what you "owe" the jar. Real payment wired in later.
Clean streak	A "days since I last texted my ex" counter (sobriety-chip energy). Resets to 0 when you log a slip. Per-person. Opt-in to share - see §6a.
3. Money Model (v1)

Tally now, payments stubbed.

Every slip carries a dollar amount (default e.g. $5, set per-jar).
We track a running total per person and per jar. It's a guilt scoreboard + virtual tip jar.
No card is charged. No money moves. A "Settle up" affordance exists and shows the amount owed, but is visibly inert ("Payments coming soon").
Critical: the data model is built so Stripe / Apple Pay can drop in later without a schema rewrite. Slips already carry amounts; jars already carry balances; "settle up" is already a concept.
Out of scope for v1: actual charges, payouts, KYC, disputes, Stripe Connect.

4. Report / Accountability Flow

Accused confirms or denies (lighter weight than a full committee vote).

Member A reports Member B: "B texted their ex." Optional note / screenshot.
B gets a notification: "Calum says you texted your ex. Fess up?"
B chooses:
Own it → slip is logged against B, tally goes up.
Deny it → report is dropped. (v2 idea: a denied report can escalate to a jar vote - "done by committee." Noted, not built.)
Self-reporting is the honest path and always available: B can log their own slip without anyone reporting.
This keeps the fun social-pressure loop without building a voting system on day one.

5. Users & Auth

Basic sign-in. Recommend Sign in with Apple (native, frictionless on iOS, no password) plus optional phone/email as fallback. One tap to get in.
A user has: display name, avatar (optional), and a list of jars they belong to.
No public profiles, no global feed. Everything is scoped to the jars you're in.
6a. Clean Streak Counter

The positive counterpart to the guilt jar. A "days since I last texted my ex" counter - the sober-chip flex.

Resets to 0 the moment you log (or own up to) a slip. Otherwise ticks up daily.
Privacy is per-person, opt-in. Both Calum and his friend are happily "in on the game" and want to share theirs - but not everyone will. So:
Each member toggles share_streak on/off per jar.
If on: your streak shows on the jar leaderboard next to your tally ("Calum - 12 days clean, $25 in").
If off: your streak is private (you still see your own; others see "-").
It's a gentle gamification hook - a number going up that you don't want to lose, sitting right next to the number you don't want to grow.
6. Screens (the iPhone screen list)

This is the part to hand to Claude for visual design. Style: super clean, modern, true-black background, bold type, playful but not childish. Think Cash App / Duolingo restraint with a cheeky voice.

Onboarding / Sign-in

The joke landing: logo, tagline ("Stop texting your ex. Or don't - but pay up."), Sign in with Apple button.
Home / My Jars

List of jars you're in. Each row: jar name, member avatars, your tally, jar total.
Big "+" to create a jar or join one (via invite code/link).
Jar Detail

The hero: the running pot total, big and dramatic.
Leaderboard of members by tally (most slips at top - the wall of shame). Members who share their clean streak show it here too (e.g. "12 days clean"); others show "-".
Recent activity feed (slips, reports, joins).
Primary action: "I texted my ex" button (self-log a slip - the core action, hard to miss).
Secondary: report a member, settle up (inert).
Log a Slip (self-report)

Confirm amount (pre-filled from jar default), optional note, optional "who" (which ex - just a label, private).
A beat of friction / humor before confirming. Submit → tally animates up.
Report a Member

Pick the member, optional note/screenshot, send. Confirmation that they'll be pinged.
Confirm/Deny a Report (the accused's view)

"Calum says you texted your ex." Note shown. Two buttons: Own it / Deny it.
Create / Join / Invite to Jar

Create: name, rule text, default slip amount, then straight into inviting friends.
Invite (first-class): share an invite link or short code via the iOS share sheet (iMessage, WhatsApp, copy link). Anyone in a jar can pull up "Invite" from the jar detail at any time, not just at creation. Opening an invite link deep-links into Join.
Join: enter code or open invite link → preview the jar (name, members, rule) → confirm join.
Notifications / Activity

Chronological feed across all jars: who slipped, who got reported, who joined, milestones ("the jar just hit $100").
Profile / Settings

Your name, avatar, notification prefs, per-jar "share my clean streak" toggles, jars list, sign out.
7. Notifications

Push notifications are a core part of the fun (and the guilt). Triggers:

You were reported → confirm/deny prompt.
Someone in your jar slipped → "Someone caved. The jar's now at $X."
Someone joined your jar.
Milestones - jar crosses a round number ($50, $100).
Streak milestones - your own clean streak hits a round number (7, 30, 100 days). Private to you unless you share your streak.
(Tunable per-user in settings; default on.)
8. Data Model (sketch, stub-ready)

IDs are Stripe-style prefix_&lt;id&gt; (e.g. jar_8af2e52a, slip_…, usr_…, rpt_…).

User usr_ - name, avatar_url, auth_provider, push_token, created_at
Jar jar_ - name, rule_text, default_amount_cents, currency, created_by, created_at
Membership mem_ - jar_id, user_id, role (owner/member), joined_at, tally_cents (derived/cached), share_streak (bool), streak_start_at (resets on slip)
Slip slip_ - jar_id, user_id (who slipped), amount_cents, note, ex_label (private), source (self|report), reported_by, created_at
Report rpt_ - jar_id, accuser_id, accused_id, note, screenshot_url?, status (pending|owned|denied), created_at, resolved_at
Invite inv_ - jar_id, code, created_by, expires_at?
Money is stored as integer cents everywhere. "Settle up" later reads tally_cents; nothing in the schema needs to change to turn payments on.

9. Suggested Stack (not the deliverable, just a recommendation)

The spec is UI-first and platform-agnostic, but since the explicit goal is iPhone screens:

Recommended: Native SwiftUI app - cleanest on-device feel, Sign in with Apple + push are native, matches the "super clean modern iOS" bar.
Faster-to-ship alt: React (Expo / React Native) if cross-platform or web matters later.
Backend: something thin - Supabase (auth + Postgres + push) or a small API. Decide at build time.
Stack choice is deferred. This spec describes what, not which framework.

10. YAGNI / Out of Scope (v1)

Real payments, payouts, settling money.
Committee voting on reports (v2 - escalation path noted).
Public profiles, global feed, friend discovery.
Multiple rule types per jar (v1 is implicitly "don't text your ex"; rule_text is free flavor).
Web app (iOS-first; web is a later port if wanted).
Analytics beyond the clean-streak counter.
11. Open Questions

Default slip amount? (proposing $5.)
Can one person be in multiple jars with different exes? (Assuming yes - jars are independent.)
Screenshots on reports - store images, or just a text note for v1? (Leaning text only for v1 to skip image storage.)
</pasted_text>

<!-- The user explicitly selected the following skills for this project, as attachments to their message. These are not optional context - they define how you work. Use them. -->
<attached-skill name="Hi-fi design">
Create a high-fidelity, polished design.

Follow this general design process (use the todo list to remember):
(1) ask questions, (2) find existing UI kits and collect design context - copy ALL relevant components and read ALL relevant examples; ask the user if you can't find them, (3) start your file with assumptions + context + design reasoning (as if you are a junior designer and the user is your manager), with placeholders for the designs, and show it to the user early, (4) build out the designs and show the user again ASAP; append some next steps, (5) use your tools to check, verify and iterate on the design.

Good hi-fi designs do not start from scratch - they are rooted in existing design context. Ask the user to Import their codebase, or find a suitable UI kit / design resources, or ask for screenshots of existing UI. You MUST spend time trying to acquire design context, including components. If you cannot find them, ask the user for them. In the Import menu, they can link a local codebase, provide screenshots or Figma links; they can also link another project. Mocking a full product from scratch is a LAST RESORT and will lead to poor design. If stuck, try listing design assets and ls'ing design system files - be proactive! Some designs may need multiple design systems - get them all. Use the starter components (device frames and the like) to get high-quality scaffolding for free.

When presenting several options or explorations side-by-side, lay them out clearly: give the page a neutral gray background, put each option in its own labeled frame (a small heading + a white rounded card sized to its content), and group related options into sections.

When designing, asking many good questions is ESSENTIAL.

Give options: try to give 3+ variations across several dimensions. Mix by-the-book designs that match existing patterns with new and novel interactions, including interesting layouts, metaphors, and visual styles. Have some options that use color or advanced CSS; some with iconography and some without. Start your variations basic and get more advanced and creative as you go! Try remixing the brand assets and visual DNA in interesting ways - play with scale, fills, texture, visual rhythm, layering, novel layouts, type treatments. The goal is not the perfect option; it's exploring atomic variations the user can mix and match.

CSS, HTML, JS and SVG are amazing. Users often don't know what they can do. Surprise the user.

If you do not have an icon, asset or component, draw a placeholder: in hi-fi design, a placeholder is better than a bad attempt at the real thing.
</attached-skill>

<attached-skill name="Interactive prototype">
Create a fully interactive prototype with realistic state management and transitions. Use React useState/useEffect for dynamic behavior. Include hover states, click interactions, form validation, animated transitions, and multi-step navigation flows. It should feel like a real working app, not a static mockup.
</attached-skill>

<attached-skill name="Design System (design system)">
[Design System] This project uses the **Design System** design system. This is a binding choice for visual style - every visual must follow it. Don't invent colors, type, spacing, or components not grounded here.

Scope: the design system is a visual style reference only. Its guide may describe example products, brands, or people that are unrelated to the user and unrelated to the subject of this conversation. Never treat anything in the design system as a fact about the user, their work, or the topic they asked about.

    Explore it to find what you need:
    - Always copy out the fonts and colors you need
    - For prototypes and designs, always copy out any relevant components
    - If the design system contains existing mocks of products, and you were asked to design or prototype something similar, copy and fork those mocks to start your design. This helps you make high-quality designs.

    Explore it quickly to find relevant UI kits (e.g. mocks of existing products you can copy and fork)

Full system at `/projects/9ddf0882-6850-49e2-aa8c-31c82e7735ad/`. Before producing any visuals, explore it: call `list_files("/projects/9ddf0882-6850-49e2-aa8c-31c82e7735ad/")` to see the structure, then `read_file` the README/base.md or whatever index file it has. Don't guess at the design system's contents.

CSS tokens: the guide may describe tokens in prose, but the exact `--*` names are defined in the design system's stylesheet(s). Before writing any `var(--*)`, look up the real name in the design system's `.css` files (`list_files` + `read_file` under `/projects/9ddf0882-6850-49e2-aa8c-31c82e7735ad/`). Never guess a token name - an unresolved `var()` silently falls back to the browser default.

For assets and UI kits beyond the guide: `read_file("/projects/9ddf0882-6850-49e2-aa8c-31c82e7735ad/<path>")` and `copy_files` to bring them into the current project.
</attached-skill>

## Assistant

_[tool: list_files]_

I'll start by exploring the design system, then ask you a few questions before diving in.

_[tool: list_files]_

_[tool: questions_v2]_

The design system project is empty, so I'll establish a visual direction grounded in the spec's stated aesthetic (true-black, bold type, Cash App / Duolingo restraint, cheeky voice). Before I build, a few questions to make sure I aim this right:

## User

Questions answered:
- deliverable: A clickable prototype AND the full screen set
- device_frame: Yes - render in a realistic iPhone bezel
- vibe: 3
- personality: TOTAL LOAD AND ROASTY AFFFFF 100% NO CAP
- hero_metaphor: Abstract - just big dramatic numbers (Cash App style)
- data_seed: Calum, Ali, Giselle, Alyssa, and the exes are Christie, Mclovin, Eddie (ali has two exes she can't text) and and giselle and alyssa have no exes (but we might add more later)

## Assistant

_[tool: update_todos]_

Got it - **true-black + yellow, loud and roasty AF, Cash App-style big numbers.** Calum, Ali, Giselle, Alyssa with exes Christie, Mclovin & Eddie. Let me set up and build a fully clickable prototype inside an iPhone frame covering every screen.

_[tool: copy_starter_component]_

_[tool: read_file]_

_[tool: write_file]_

No design system files exist, so I'll establish the visual direction from the spec: **true black, gold (#FFD23F) for money/primary, iOS red for slips, green for clean streaks; Bricolage Grotesque for big dramatic numbers + Hanken Grotesk for UI; loud roasty voice.** Building a full clickable prototype in the iPhone frame now.

Let me write the seed data first.

_[tool: write_file]_

Now the shared UI primitives, icons, and design tokens:

_[tool: str_replace_edit]_

Good catch - the updated spec makes **report evidence** richer: text note **and/or image attachments** (screenshots), at least one required, shown full-screen-tappable on the accused's confirm/deny view. I'll bake that in - a screenshot picker in *Report a Member* and tappable evidence shots in *Confirm/Deny*. Let me update the data and keep building.

## User

also one more to add sorry, allow anon report

## Assistant

_[tool: str_replace_edit]_

On it - anonymous reporting added: a "Send anonymously" toggle in *Report a Member*, and the accused sees "Someone in the jar says…" instead of a name. I'll show the anonymous variant in the pending report so the feature is visible.

_[tool: write_file]_

Now shared interactive bits - toggle, amount stepper, the fake-screenshot evidence component, full-screen viewer, and a money-burst animation:

_[tool: write_file]_

Now the core screens - onboarding, home, jar detail (the hero), activity, and profile:

_[tool: write_file]_

Now the action flows - log a slip (with the money burst), report a member (with screenshot evidence + anonymous toggle), confirm/deny, and settle up:

_[tool: write_file]_

Yes! Let me finish the last screens (create/join/invite, profile) and wire up the app shell so you can click through it.Now the app shell that wires it all together - navigation, state, tab bar, inside the iPhone frame:

_[tool: write_file]_

_[tool: show_html]_

_[tool: show_html]_

_[tool: get_webview_logs]_

Blank - let me check the console.

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: eval_js]_

_[tool: save_screenshot]_

It's actually rendering - the capture just glitched. Let me grab a fresh screenshot.

_[tool: save_screenshot]_

_[tool: eval_js]_

_[tool: str_replace_edit]_

Found it - the per-screen entrance animation is frozen at its `opacity:0` start frame (the resting state must be visible per the animation guidance). Let me make the entrance transform-only so content is never invisible.

_[tool: save_screenshot]_

_[tool: str_replace_edit]_

Content is in the DOM but the capture (html-to-image) can't render my `position:absolute` overlay inside the scaled device. Let me restructure to render content in normal flow inside the device frame, which also captures correctly.

_[tool: save_screenshot]_

_[tool: eval_js]_

Let me test whether the device's `overflow:auto` wrapper is what html-to-image can't capture:

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: eval_js]_

_[tool: save_screenshot]_

_[tool: show_html]_

The capture tool (html-to-image) can't rasterize content nested in the device frame, but the DOM proves it's there and styled. Let me reload to clear my eval mutations and get an authoritative real-browser screenshot from the verifier.

_[tool: fork_verifier_agent]_

_[tool: snip]_

The verifier is checking the real render. While it does, let me clear some context from the duplicated spec pastes (already encoded into the app).

_[tool: snip]_

I'll end my turn and wait for the verifier's report on the real render.

## User

Verifier agent check completed

