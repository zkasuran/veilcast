import type { Metadata } from 'next'
import './globals.css'

// Fonts are self-contained system stacks (set in globals.css via --font-body / --font-mono-ui).
// A static export must build identically offline, on GitHub Pages, IPFS or any CDN, without a
// request to Google Fonts — so the layout does not fetch a webfont at build time.

export const metadata: Metadata = {
  title: 'Veilcast · private prediction markets you or an agent can trade',
  description:
    'A private prediction market on Starknet. Public volume so the odds mean something, anonymous bettors so they stay honest. Trade it from a browser wallet. Trade it headlessly from a process. An agent carries a bounded mandate written into the contract, so it can close your position and cannot take your money.',
}

/**
 * Inline script that runs before React hydrates — reads localStorage and sets
 * data-theme on <html> so there's zero flash of wrong theme (FOWT).
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
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
