/** @type {import('next').NextConfig} */
const { execSync } = require("node:child_process");

// Stable per commit, so the same source always builds the same static files (and the
// same IPFS CID). Unique per build only when no commit is available.
function commitSha() {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}
const buildId = process.env.VERCEL_GIT_COMMIT_SHA || commitSha() || `dev-${Date.now()}`;

const nextConfig = {
  // Static HTML export: the app has no server routes, so it can be served from IPFS.
  output: "export",
  // Keep one index.html per route, so IPFS gateways resolve deep links on refresh.
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@aragon/ods"],
  generateBuildId: () => buildId,
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

module.exports = nextConfig;
