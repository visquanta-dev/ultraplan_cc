import { type VercelConfig } from '@vercel/config/v1';

// UltraPlan — VisQuanta blog portal
// Cron jobs are added in Phase 3 when the pipeline is end-to-end working.
// For Phase 1 this config just pins the framework and build command so
// the Vercel preview deploys cleanly.

export const config: VercelConfig = {
  framework: 'nextjs',
  buildCommand: 'npm run build',
};
