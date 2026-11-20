/**
 * The Kawman ExAct mark. The file sits in public/logo.png; if it is ever missing the
 * company name is shown in its place, so a screen never carries a broken image.
 */
import { useState } from 'react';

export function Logo({ height = 40, className = '' }: { height?: number; className?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className={`logo-fallback ${className}`}>Kawman ExAct</span>;
  return (
    <img
      className={`logo ${className}`}
      src="./logo.png"
      alt="Kawman ExAct, Leading Innovations. Improving Performances."
      style={{ height }}
      onError={() => setMissing(true)}
    />
  );
}
