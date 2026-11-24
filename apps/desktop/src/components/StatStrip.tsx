import type { ReactNode } from 'react';

export type StatTone = 'ok' | 'warn' | 'danger' | 'info';

export interface StatTile {
  label: string;
  value: number;
  tone?: StatTone;
}

/** A row of at-a-glance summary tiles with a coloured accent per tone. */
export function StatStrip({ tiles }: { tiles: StatTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <div className="stat-strip">
      {tiles.map((t) => (
        <div key={t.label} className={`stat-tile${t.tone ? ` stat-tile--${t.tone}` : ''}`}>
          <div className="stat-tile__value">{t.value}</div>
          <div className="stat-tile__label">{t.label}</div>
        </div>
      ))}
    </div>
  );
}

/** Friendly centred empty state with an icon, title and hint. */
export function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">{icon}</div>
      <div className="empty__title">{title}</div>
      <p className="empty__text">{text}</p>
    </div>
  );
}

/** Shimmer placeholder rows shown while a table loads. */
export function SkeletonRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <td key={c}><div className="skel skel--md" style={{ width: c === 0 ? '70%' : '90%' }} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Two-letter initials for a name, for avatar chips. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}