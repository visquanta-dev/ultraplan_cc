import { type VercelConfig } from '@vercel/config/v1';

// UltraPlan — VisQuanta blog portal
// Scheduling is handled by GitHub Actions (.github/workflows/daily-blog.yml).
// Keep Vercel Cron disabled so the pipeline has one scheduler and one set of
// logs/secrets.

export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'npm run build',
};
