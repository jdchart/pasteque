/* The mark: a slice of watermelon drawn in ink — rind, flesh, seeds — so it
   sits in the suite's monochrome look. Seeds in the accent. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 9 A13 13 0 0 0 29 9 Z" fill="var(--s-paper)" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M6.6 11.5 A10 10 0 0 0 25.4 11.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <g fill="var(--s-accent)">
        <ellipse cx="11" cy="14" rx="1" ry="1.6" transform="rotate(-20 11 14)" />
        <ellipse cx="16" cy="16.5" rx="1" ry="1.6" />
        <ellipse cx="21" cy="14" rx="1" ry="1.6" transform="rotate(20 21 14)" />
      </g>
    </svg>
  );
}
