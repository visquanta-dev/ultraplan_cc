import { Fraunces, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

// Editorial-brutalist type stack — scoped to /admin only so the root site
// isn't affected. Display: Fraunces (variable serif). Body: Plus Jakarta
// Sans (brand body font). Mono: JetBrains Mono (all data + labels).
const fraunces = Fraunces({
  variable: '--font-display',
  subsets: ['latin'],
  display: 'swap',
  axes: ['opsz', 'SOFT', 'WONK'],
});

const jakarta = Plus_Jakarta_Sans({
  variable: '--font-body',
  subsets: ['latin'],
  display: 'swap',
});

const mono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  display: 'swap',
});

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${fraunces.variable} ${jakarta.variable} ${mono.variable}`}
      style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
    >
      {children}
    </div>
  );
}
