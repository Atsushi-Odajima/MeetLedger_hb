// Brand logo: uses the brand engineer's SVGs from src/assets/logo-*.svg when present (globbed, so a missing file never
// breaks the build), otherwise a typographic fallback.
const logos = import.meta.glob('../assets/logo-*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function pick(preferred: string[]): string | null {
  const entries = Object.entries(logos);
  for (const p of preferred) {
    const hit = entries.find(([k]) => k.toLowerCase().includes(p));
    if (hit) return hit[1];
  }
  return entries[0]?.[1] ?? null;
}

export function Logo({ variant = 'full', className }: { variant?: 'full' | 'mark'; className?: string }) {
  const src = variant === 'mark' ? pick(['mark', 'symbol', 'icon']) : pick(['horizontal', 'full', 'wordmark', 'lockup', 'logo-light', 'primary']);
  if (src)
    return (
      <span className={`logo logo-${variant}${className ? ` ${className}` : ''}`}>
        <img src={src} alt="MeetLedger" />
      </span>
    );
  return (
    <span className={`logo logo-text${className ? ` ${className}` : ''}`} aria-label="MeetLedger">
      <span className="logo-mark" aria-hidden="true">
        M
      </span>
      {variant === 'full' && <span className="logo-word">MeetLedger</span>}
    </span>
  );
}
