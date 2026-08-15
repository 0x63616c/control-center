# Text Your Ex - Product Spec

**Date:** 2026-06-07
**Status:** Draft for review
**Author:** Calum + Claude

---

## 1. The Pitch

A group accountability app for one very specific failure mode: **texting your ex.**

You and your friends know who shouldn't be texting whom. So you make a pact, throw your slip-ups
into a shared jar, and watch the guilt money pile up. Every time someone caves and texts their ex,
it gets logged. The tally grows. Your friends find out. Shame, but make it a leaderboard.

The name is the joke, said straight: **Text Your Ex** - an app you open *instead* of texting your ex.
You log the urge (or the slip) here rather than sending the message you'll regret.

**One-line:** *A shared guilt jar for friends trying not to text their exes.*

---

## 2. Core Concepts

| Concept | What it is |
|---|---|
| **Jar** | A named accountability group. Has members, a rule, and a running tally/pot. (Playful alt-name: "a Jaw." Functionally identical - rename is a config flag.) |
| **Slip** | One logged incident of texting your ex. Has a $ amount, timestamp, optional note, and the person it's attributed to. |
| **Tally** | The running total. Per-person and per-jar. The scoreboard. |
| **Report** | When a member flags *another* member for a slip they didn't self-log. Goes to the accused to confirm or deny. |
| **Settle up** | Inert button in v1. Shows what you "owe" the jar. Real payment wired in later. |
| **Clean streak** | A "days since I last texted my ex" counter (sobriety-chip energy). Resets to 0 when you log a slip. Per-person. **Opt-in to share** - see §6a. |

---

## 3. Money Model (v1)

**Tally now, payments stubbed.**

- Every slip carries a dollar amount (default e.g. `$5`, set per-jar).
- We track a running total per person and per jar. It's a guilt scoreboard + virtual tip jar.
- **No card is charged. No money moves.** A "Settle up" affordance exists and shows the amount owed,
  but is visibly inert ("Payments coming soon").
- **Critical:** the data model is built so Stripe / Apple Pay can drop in later without a schema rewrite.
  Slips already carry amounts; jars already carry balances; "settle up" is already a concept.

Out of scope for v1: actual charges, payouts, KYC, disputes, Stripe Connect.

---

## 4. Report / Accountability Flow

**Accused confirms or denies** (lighter weight than a full committee vote).

1. Member A reports Member B: "B texted their ex." Attaches **evidence** - a text note and/or one or
   more image attachments (screenshots of the messages, etc.). At least one of note/image required.
   - **Anonymous toggle:** A can send the report anonymously. The accused and the jar see *"Someone in
     the jar"* instead of A's name. (Server still stores the real accuser_id for abuse prevention; it's
     just hidden from members.)
2. B gets a notification: *"Someone says you texted your ex. Fess up?"* (or "Calum says…" if not anon).
3. B chooses:
   - **Own it** → slip is logged against B, tally goes up.
   - **Deny it** → report is dropped. (v2 idea: a denied report can escalate to a jar vote - "done by
     committee." Noted, not built.)
4. Self-reporting is the honest path and always available: B can log their own slip without anyone reporting.

This keeps the fun social-pressure loop without building a voting system on day one.

---

## 5. Users & Auth

- **Basic sign-in.** Recommend **Sign in with Apple** (native, frictionless on iOS, no password) plus
  optional phone/email as fallback. One tap to get in.
- A user has: display name, avatar (optional), and a list of jars they belong to.
- No public profiles, no global feed. Everything is scoped to the jars you're in.

---

## 6a. Clean Streak Counter

The positive counterpart to the guilt jar. A **"days since I last texted my ex"** counter - the
sober-chip flex.

- Resets to `0` the moment you log (or own up to) a slip. Otherwise ticks up daily.
- **Privacy is per-person, opt-in.** Both Calum and his friend are happily "in on the game" and want to
  share theirs - but not everyone will. So:
  - Each member toggles `share_streak` on/off per jar.
  - If **on**: your streak shows on the jar leaderboard next to your tally ("Calum - 12 days clean, $25 in").
  - If **off**: your streak is private (you still see your own; others see "-").
- It's a gentle gamification hook - a number going up that you don't want to lose, sitting right next to
  the number you don't want to grow.

## 6. Screens (the iPhone screen list)

This is the part to hand to Claude for visual design. Style: **super clean, modern, true-black background,
bold type, playful but not childish.** Think Cash App / Duolingo restraint with a cheeky voice.

1. **Onboarding / Sign-in**
   - The joke landing: logo, tagline ("Stop texting your ex. Or don't - but pay up."), Sign in with Apple button.

2. **Home / My Jars**
   - List of jars you're in. Each row: jar name, member avatars, your tally, jar total.
   - Big "+" to create a jar or join one (via invite code/link).

3. **Jar Detail**
   - The hero: the running pot total, big and dramatic.
   - Leaderboard of members by tally (most slips at top - the wall of shame). Members who share their
     clean streak show it here too (e.g. "12 days clean"); others show "-".
   - Recent activity feed (slips, reports, joins).
   - Primary action: **"I texted my ex"** button (self-log a slip - the core action, hard to miss).
   - Secondary: report a member, settle up (inert).

4. **Log a Slip (self-report)**
   - Confirm amount (pre-filled from jar default), optional note, optional "who" (which ex - just a label, private).
   - A beat of friction / humor before confirming. Submit → tally animates up.

5. **Report a Member**
   - Pick the member, add evidence: a note and/or image attachments (screenshot picker / camera roll),
     **"Send anonymously" toggle**, send. Confirmation that they'll be pinged.

6. **Confirm/Deny a Report (the accused's view)**
   - "Calum says you texted your ex" - or "**Someone** says you texted your ex" if anonymous. Evidence
     shown - the note and any screenshots, full-screen tappable. Two buttons: **Own it** / **Deny it.**

7. **Create / Join / Invite to Jar**
   - Create: name, rule text, default slip amount, then straight into inviting friends.
   - **Invite (first-class):** share an invite link or short code via the iOS share sheet (iMessage,
     WhatsApp, copy link). Anyone in a jar can pull up "Invite" from the jar detail at any time, not just
     at creation. Opening an invite link deep-links into Join.
   - Join: enter code or open invite link → preview the jar (name, members, rule) → confirm join.

8. **Notifications / Activity**
   - Chronological feed across all jars: who slipped, who got reported, who joined, milestones
     ("the jar just hit $100").

9. **Profile / Settings**
   - Your name, avatar, notification prefs, per-jar "share my clean streak" toggles, jars list, sign out.

---

## 7. Notifications

Push notifications are a core part of the fun (and the guilt). Triggers:

- You were **reported** → confirm/deny prompt.
- Someone in your jar **slipped** → "Someone caved. The jar's now at $X."
- Someone **joined** your jar.
- **Milestones** - jar crosses a round number (`$50`, `$100`).
- **Streak milestones** - your own clean streak hits a round number (`7`, `30`, `100` days). Private to you
  unless you share your streak.
- (Tunable per-user in settings; default on.)

---

## 8. Data Model (sketch, stub-ready)

IDs are Stripe-style `prefix_<id>` (e.g. `jar_8af2e52a`, `slip_…`, `usr_…`, `rpt_…`).

- **User** `usr_` - name, avatar_url, auth_provider, push_token, created_at
- **Jar** `jar_` - name, rule_text, default_amount_cents, currency, created_by, created_at
- **Membership** `mem_` - jar_id, user_id, role (owner/member), joined_at, tally_cents (derived/cached), share_streak (bool), streak_start_at (resets on slip)
- **Slip** `slip_` - jar_id, user_id (who slipped), amount_cents, note, ex_label (private), source (self|report), reported_by, created_at
- **Report** `rpt_` - jar_id, accuser_id (always stored, hidden from members if anon), accused_id, note, is_anonymous (bool), status (pending|owned|denied), created_at, resolved_at
- **Evidence** `evi_` - report_id, kind (image), url, created_at  *(one report → many evidence images; the note lives on the report)*
- **Invite** `inv_` - jar_id, code, created_by, expires_at?

Image evidence needs blob storage (e.g. Supabase Storage / S3) and the Storage screen in §6 #5/#6 reads
and writes it. This is the one piece of infra v1 adds beyond a plain DB.

Money is stored as integer cents everywhere. "Settle up" later reads `tally_cents`; nothing in the schema
needs to change to turn payments on.

---

## 9. Suggested Stack (not the deliverable, just a recommendation)

The spec is UI-first and platform-agnostic, but since the explicit goal is **iPhone screens**:

- **Recommended:** Native **SwiftUI** app - cleanest on-device feel, Sign in with Apple + push are native,
  matches the "super clean modern iOS" bar.
- **Faster-to-ship alt:** React (Expo / React Native) if cross-platform or web matters later.
- **Backend:** something thin - Supabase (auth + Postgres + push) or a small API. Decide at build time.

Stack choice is deferred. This spec describes *what*, not *which framework*.

---

## 10. YAGNI / Out of Scope (v1)

- Real payments, payouts, settling money.
- Committee voting on reports (v2 - escalation path noted).
- Public profiles, global feed, friend discovery.
- Multiple rule types per jar (v1 is implicitly "don't text your ex"; rule_text is free flavor).
- Web app (iOS-first; web is a later port if wanted).
- Analytics beyond the clean-streak counter.
- **Contacts integration** (a "delete your ex" ritual that verifies the contact is gone, on-device).
  Parked - interesting but not loved right now. Revisit in v2 if the core loop is fun.

---

## 11. Resolved Decisions

- **Slip amount:** default `$5`, configurable per jar.
- **Multiple jars per person:** yes - jars are independent (you can be in several with different exes).
- **Report evidence:** text note **and/or image attachments** in v1 (at least one required). Requires
  blob storage - see §8.
