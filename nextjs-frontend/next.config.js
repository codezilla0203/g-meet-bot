/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  async rewrites() {
    // Backend URL - use environment variable or default to localhost:5000
    // In production, this should be the backend server URL (can be localhost if on same server)
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
    
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`, // Proxy to backend on port 5000
      },
      {
        source: '/v1/:path*',
        destination: `${backendUrl}/v1/:path*`, // Proxy to backend API routes
      },
      {
        source: '/share/:path*',
        destination: `${backendUrl}/api/share/:path*`, // Proxy share routes
      },
    ]
  },
}

module.exports = nextConfig
