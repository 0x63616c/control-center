// app-data.jsx - seed data + helpers for Text Your Ex
// All money is integer cents. People, jars, slips, reports, activity.

const PEOPLE = {
  usr_calum: { id: "usr_calum", name: "Calum", color: "#5E5CE6", exes: ["Christie"] },
  usr_ali: { id: "usr_ali", name: "Ali", color: "#FF375F", exes: ["Mclovin", "Eddie"] },
  usr_giselle: { id: "usr_giselle", name: "Giselle", color: "#30D158", exes: [] },
  usr_alyssa: { id: "usr_alyssa", name: "Alyssa", color: "#FF9F0A", exes: [] },
};

const ME = "usr_calum";

// Memberships carry the per-jar state: tally, streak, share toggle.
// daysClean is precomputed for the demo (streak_start_at relative).
const JARS = [
  {
    id: "jar_8af2e52a",
    name: "The Group Chat",
    rule: "Don't text your ex. We all know who. We mean it.",
    defaultCents: 500,
    members: [
      { user: "usr_ali", role: "owner", tallyCents: 6500, daysClean: 0, shareStreak: true },
      { user: "usr_calum", role: "member", tallyCents: 4000, daysClean: 4, shareStreak: true },
      { user: "usr_giselle", role: "member", tallyCents: 0, daysClean: 999, shareStreak: true },
      { user: "usr_alyssa", role: "member", tallyCents: 0, daysClean: 12, shareStreak: false },
    ],
  },
  {
    id: "jar_3c91d7b0",
    name: "Dry January (Failed)",
    rule: "New year, same bad decisions. $10 a pop.",
    defaultCents: 1000,
    members: [
      { user: "usr_calum", role: "owner", tallyCents: 3000, daysClean: 4, shareStreak: true },
      { user: "usr_ali", role: "member", tallyCents: 2000, daysClean: 0, shareStreak: true },
    ],
  },
];

// Recent activity, newest first. type: slip | report | join | milestone
const ACTIVITY = [
  {
    id: "a1",
    jar: "jar_8af2e52a",
    type: "slip",
    user: "usr_ali",
    amountCents: 500,
    ex: "Eddie",
    ago: "12m",
    note: "it was his birthday ok",
  },
  {
    id: "a2",
    jar: "jar_8af2e52a",
    type: "milestone",
    text: "The jar just cracked $100. Disgraceful.",
    ago: "12m",
  },
  {
    id: "a3",
    jar: "jar_3c91d7b0",
    type: "slip",
    user: "usr_calum",
    amountCents: 1000,
    ex: "Christie",
    ago: "2h",
    note: null,
  },
  {
    id: "a4",
    jar: "jar_8af2e52a",
    type: "report",
    user: "usr_ali",
    by: "usr_giselle",
    ago: "5h",
    note: 'saw the "u up" at 2am',
  },
  {
    id: "a5",
    jar: "jar_8af2e52a",
    type: "slip",
    user: "usr_calum",
    amountCents: 500,
    ex: "Christie",
    ago: "1d",
    note: null,
  },
  { id: "a6", jar: "jar_8af2e52a", type: "join", user: "usr_alyssa", ago: "3d" },
  {
    id: "a7",
    jar: "jar_8af2e52a",
    type: "slip",
    user: "usr_ali",
    amountCents: 500,
    ex: "Mclovin",
    ago: "4d",
    note: null,
  },
];

// A pending report aimed at ME (Calum) - drives the confirm/deny screen.
// Evidence: a note + image attachments (fake iMessage threads drawn in CSS).
const PENDING_REPORT = {
  id: "rpt_4d9a",
  jar: "jar_8af2e52a",
  accused: "usr_calum",
  accuser: "usr_giselle",
  anonymous: true,
  note: "Christie posted a story and you replied in 4 seconds flat. We saw the screenshots. Pay up.",
  ago: "8m",
  amountCents: 500,
  evidence: [
    {
      id: "evi_1",
      to: "Christie",
      time: "2:14 AM",
      bubbles: [
        { me: true, text: "u up?" },
        { me: false, text: "calum it is 2am" },
        { me: true, text: "i know. i just miss the way you-" },
      ],
    },
    {
      id: "evi_2",
      to: "Christie",
      time: "2:21 AM",
      bubbles: [
        { me: false, text: "we broke up for a reason" },
        { me: true, text: "name one" },
        { me: true, text: "exactly" },
      ],
    },
  ],
};

// ---- helpers ----
function money(cents) {
  const v = cents / 100;
  return "$" + (Number.isInteger(v) ? v : v.toFixed(2));
}
function jarTotal(jar) {
  return jar.members.reduce((s, m) => s + m.tallyCents, 0);
}
function myMembership(jar) {
  return jar.members.find((m) => m.user === ME);
}
function person(id) {
  return PEOPLE[id];
}
function initials(name) {
  return name.slice(0, 2);
}

function streakLabel(m) {
  const p = PEOPLE[m.user];
  if (!m.shareStreak) return null;
  if (p && p.exes.length === 0) return "forever clean";
  if (m.daysClean === 0) return "just caved";
  return `${m.daysClean} ${m.daysClean === 1 ? "day" : "days"} clean`;
}

Object.assign(window, {
  PEOPLE,
  ME,
  JARS,
  ACTIVITY,
  PENDING_REPORT,
  money,
  jarTotal,
  myMembership,
  person,
  initials,
  streakLabel,
});
