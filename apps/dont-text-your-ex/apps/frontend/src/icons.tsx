import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

export const Icon = {
  back: (p: P) => (
    // Left chevron carries more ink on the right, so nudge left (marginLeft -2)
    // to sit optically centered inside the round IconBtn.
    <svg
      aria-hidden="true"
      width="9"
      height="15"
      viewBox="0 0 11 18"
      fill="none"
      {...p}
      style={{ marginLeft: -2, ...(p.style as object) }}
    >
      <path
        d="M9 1L2 9l7 8"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  plus: (p: P) => (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" {...p}>
      <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  ),
  chev: (p: P) => (
    <svg aria-hidden="true" width="8" height="14" viewBox="0 0 8 14" fill="none" {...p}>
      <path
        d="M1 1l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  jars: (p: P) => (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M7 2h10M6 6h12l-1 13a3 3 0 01-3 3H10a3 3 0 01-3-3L6 6z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M6.5 13h11" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  bell: (p: P) => (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M12 3a6 6 0 016 6c0 6 2 7 2 7H4s2-1 2-7a6 6 0 016-6zM10 20a2 2 0 004 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  user: (p: P) => (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  flag: (p: P) => (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M5 21V4m0 1h12l-2 4 2 4H5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  share: (p: P) => (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M12 15V3m0 0L8 7m4-4l4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  copy: (p: P) => (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"
        stroke="currentColor"
        strokeWidth="1.9"
      />
    </svg>
  ),
  check: (p: P) => (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M4 12l5 6L20 5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  x: (p: P) => (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M5 5l14 14M19 5L5 19"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  apple: (p: P) => (
    <svg aria-hidden="true" width="18" height="22" viewBox="0 0 18 22" fill="currentColor" {...p}>
      <path d="M14.6 11.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.7-3-2-3.7-2-1.6-.2-3 .9-3.8.9-.8 0-2-.9-3.2-.9C4.4 5.7 2.8 6.7 2 8.3c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.7 2.5 3 2.4 1.2 0 1.6-.8 3.1-.8 1.4 0 1.8.8 3.1.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.5-3.6zM12.1 4c.7-.8 1.1-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.3z" />
    </svg>
  ),
  party: (p: P) => (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M3 21l5-13 8 8-13 5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M14 3v2M19 6l-1.4 1.4M21 11h-2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
};
