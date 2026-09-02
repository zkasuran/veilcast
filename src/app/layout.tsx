import type { Metadata } from 'next'
import { Inter, Space_Mono } from 'next/font/google'
import './globals.css'

// Clean neutral grotesque for everything (matches the Uniswap reference); a mono
// only for hex addresses / hashes.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})
const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono-ui',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Veilcast · delegate execution, never custody',
  description:
    'A private, leveraged prediction market on Starknet that an AI agent can trade for you and structurally cannot steal from. Public volume so the odds mean something, anonymous bettors so they stay honest, plus a bounded on-chain mandate so delegating execution never delegates custody.',
}

/**
 * Inline script that runs before React hydrates — reads localStorage and sets
 * data-theme on <html> so there's zero flash of wrong theme (FOWT).
 * Wrapped in a <script> tag with dangerouslySetInnerHTML because Next.js
 * static export cannot inject blocking scripts any other way.
 */
const THEME_INIT_SCRIPT = `
(function(){
  try {
    var t = localStorage.getItem('veilcast-theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch(e) {}
})();
`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
