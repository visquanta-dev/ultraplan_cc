import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/cron/trigger': ['./config/calculators.yaml'],
  },
};

export default nextConfig;
