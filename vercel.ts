import { type VercelConfig } from '@vercel/config/v1';

// UltraPlan — VisQuanta blog portal
// Cron fires daily at 06:00 CT (11:00 UTC).
// Lane resolution happens in the route handler.

export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'npm run build',
  crons: [
    {
      path: '/api/cron/trigger',
      schedule: '0 11 * * *', // 06:00 CT = 11:00 UTC, every day
    },
  ],
};
