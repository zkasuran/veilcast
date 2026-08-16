/** @type {import('next').NextConfig} */

// The demo ships as a static export so it can be hosted anywhere, including GitHub Pages. Every
// action happens in the browser against the chain and the wallet, so there is no server to lose by
// exporting. A project page is served under a path, hence the base path, which stays empty for a
// local build and for any host serving the app at the root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

const nextConfig = {
  reactStrictMode: false,
  output: 'export',
  basePath,
  // Trailing slashes keep links working on a static host that serves index.html per folder.
  trailingSlash: true,
  images: { unoptimized: true },
}

module.exports = nextConfig
