// Line icons for Meridian's chart chrome (drawn for Meridian; 1.6 px strokes, currentColor).
import type { ReactNode } from "react";

export const Icon = ({ d, size = 22, children }: { d?: string; size?: number; children?: ReactNode }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d && <path d={d} />}
    {children}
  </svg>
);

export const I = {
  chevron: <Icon d="M6 9l6 6 6-6" size={14} />,
  candles: (
    <Icon>
      <path d="M8 4v3M8 15v5M16 3v3M16 13v4" />
      <rect x="6" y="7" width="4" height="8" rx="0.5" />
      <rect x="14" y="6" width="4" height="7" rx="0.5" />
    </Icon>
  ),
  indicators: <Icon d="M3 20h18M5 16l4-5 4 3 6-8M17 6h2v2" />,
  undo: <Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3" />,
  redo: <Icon d="M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3" />,
  fullscreen: <Icon d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  camera: (
    <Icon>
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </Icon>
  ),
  gear: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </Icon>
  ),
  cross: <Icon d="M12 3v7M12 14v7M3 12h7M14 12h7" />,
  trend: (
    <Icon>
      <path d="M6 18L18 6" />
      <circle cx="5" cy="19" r="1.6" />
      <circle cx="19" cy="5" r="1.6" />
    </Icon>
  ),
  ray: <Icon d="M5 19L19 5M14 5h5v5" />,
  hline: <Icon d="M3 12h18" />,
  vline: <Icon d="M12 3v18" />,
  fib: (
    <Icon>
      <path d="M4 6h14M4 10h16M4 14h12M4 18h16" />
      <circle cx="20" cy="6" r="1.4" />
    </Icon>
  ),
  rect: <Icon d="M5 7h14v10H5z" />,
  brush: <Icon d="M4 20c3 0 4-2 4-4 0-1.5 1-3 3-3s3 1.5 3 3M14 13l6-9" />,
  text: <Icon d="M5 6V4h14v2M12 4v16M9 20h6" />,
  long: (
    <Icon>
      <path d="M4 12h16" />
      <path d="M6 5h12v7H6z" />
      <path d="M8 15h8v4H8z" />
    </Icon>
  ),
  short: (
    <Icon>
      <path d="M4 12h16" />
      <path d="M6 12h12v7H6z" />
      <path d="M8 5h8v4H8z" />
    </Icon>
  ),
  ruler: <Icon d="M4 16L16 4l4 4L8 20zM8 12l2 2M11 9l2 2M14 6l2 2" />,
  zoomIn: (
    <Icon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.4-4.4M11 8v6M8 11h6" />
    </Icon>
  ),
  magnet: <Icon d="M6 4v7a6 6 0 0012 0V4M6 8h4M14 8h4" />,
  lock: <Icon d="M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z" />,
  unlock: <Icon d="M7 11V8a5 5 0 019.9-1M5 11h14v9H5z" />,
  erase: <Icon d="M16 4l4 4-10 10H6l-2-2 12-12zM4 20h16" />,
  trash: <Icon d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
};
