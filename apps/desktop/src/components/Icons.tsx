import type { ReactNode } from 'react';

/** Small line icons for the sidebar. One stroke weight and size so the set reads as one family. */
function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

export const Icons = {
  dashboard: <Svg><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>,
  trf: <Svg><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></Svg>,
  assignments: <Svg><path d="M9 11l2 2 4-4" /><rect x="4" y="4" width="16" height="16" rx="2" /></Svg>,
  approvals: <Svg><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></Svg>,
  employees: <Svg><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 0 3.5 5.5" /></Svg>,
  reports: <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>,
  audit: <Svg><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3M11 8v3.5l2.2 1.3" /></Svg>,
  lock: <Svg><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>,
  switchUser: <Svg><path d="M16 3l4 4-4 4M20 7H9a5 5 0 0 0-5 5M8 21l-4-4 4-4M4 17h11a5 5 0 0 0 5-5" /></Svg>,
  signOut: <Svg><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>,
  bell: <Svg><path d="M12 22a2 2 0 0 0 2-2H9c0 1.1.9 2 2 2z" /><path d="M16 19V12c0-2.2-1.2-4.1-3-5V5a3 3 0 0 0-6 0v2c-1.8 1-3 2.9-3 5v7" /></Svg>,
  bellOff: <Svg><path d="M16 19A3 3 0 0 1 9 19H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1M16 9a6 6 0 0 0-5-5v2a5 5 0 0 1 5 5z" /><path d="M9 16V9a6 6 0 0 1 5-5" /><path d="M1 1l22 22" /></Svg>,
  check: <Svg><path d="M20 6L9 17l-5-5" /></Svg>,
  trash: <Svg><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></Svg>,
  plus: <Svg><path d="M12 5v14M5 12h14" /></Svg>,
};
