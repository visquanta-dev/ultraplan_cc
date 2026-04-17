import fs from 'node:fs';
import path from 'node:path';
import type { GateReport } from './gates/types';
import type { Bundle } from './bundle/types';

// ---------------------------------------------------------------------------
// GitHub PAT client — spec §8 (stage 7)
// Creates branches and PRs on visquanta-dev/site using a Personal Access Token.
// Scopes needed: repo (contents + pull requests).
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const TARGET_REPO = 'visquanta-dev/site';

function getToken(): string {
  const token = process.env.GITHUB_PAT;
  if (!token) {
    throw new Error('[github] Missing env var: GITHUB_PAT');
  }
  return token;
}

async function ghFetch(
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = getToken();
  return fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// File operations (via Contents API)
// ---------------------------------------------------------------------------

/**
 * Get the SHA of the default branch's latest commit.
 */
async function getDefaultBranchSha(): Promise<{ sha: string; branch: string }> {
  const res = await ghFetch(`/repos/${TARGET_REPO}`);
  if (!res.ok) throw new Error(`[github] Failed to get repo info: ${res.status}`);
  const repo = await res.json() as { default_branch: string };

  const refRes = await ghFetch(`/repos/${TARGET_REPO}/git/ref/heads/${repo.default_branch}`);
  if (!refRes.ok) throw new Error(`[github] Failed to get ref: ${refRes.status}`);
  const ref = await refRes.json() as { object: { sha: string } };

  return { sha: ref.object.sha, branch: repo.default_branch };
}

/**
 * Create a new branch from the default branch.
 */
async function createBranch(branchName: string): Promise<void> {
  const { sha } = await getDefaultBranchSha();
  const res = await ghFetch(`/repos/${TARGET_REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[github] Failed to create branch ${branchName}: ${res.status} ${text}`);
  }
}

/**
 * Create or update a file on a branch via the Contents API.
 */
async function upsertFile(
  branchName: string,
  filePath: string,
  content: string | Buffer,
  message: string,
): Promise<void> {
  const base64Content = Buffer.isBuffer(content)
    ? content.toString('base64')
    : Buffer.from(content, 'utf-8').toString('base64');

  // Check if file exists (to get its SHA for update)
  const existsRes = await ghFetch(
    `/repos/${TARGET_REPO}/contents/${filePath}?ref=${branchName}`,
  );
  let sha: string | undefined;
  if (existsRes.ok) {
    const existing = await existsRes.json() as { sha: string };
    sha = existing.sha;
  }

  const res = await ghFetch(`/repos/${TARGET_REPO}/contents/${filePath}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: base64Content,
      branch: branchName,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[github] Failed to upsert ${filePath}: ${res.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// PR creation — spec §8
// ---------------------------------------------------------------------------

export interface CreateDraftPRInput {
  slug: string;
  lane: 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle';
  markdownContent: string;
  images: Array<{ relativePath: string; absolutePath: string }>;
  gateReport: GateReport;
  bundle: Bundle;
  metadata?: Record<string, unknown>;
  /**
   * Set to true when the hero image pipeline failed all retries and
   * the post is shipping with a fallback placeholder image. Adds a
   * hero-missing label and a prominent warning to the PR body so the
   * reviewer knows to replace the hero before merging.
   */
  heroFallbackUsed?: boolean;
  /**
   * SEO + AEO rubric score (0-100). Rendered in the PR body and stored
   * in the metadata file for admin dashboard tracking.
   */
  seoAeoScore?: number;
  /**
   * True when score is in the 70-84% warning band (passes the gate but
   * below the target 85% threshold). Adds an `seo-aeo-warning` label
   * so humans can easily find and fix borderline posts.
   */
  seoAeoWarning?: boolean;
  /**
   * Hero image options from the multi-option image pipeline. When present,
   * a preview section is added to the PR body so the reviewer can pick one
   * before merging.
   */
  imageOptions?: Array<{
    label: string;
    source: 'ai' | 'pexels';
    path: string;
    overlayPath: string;
    altText: string;
    photographer?: string;
  }>;
}

export interface CreateDraftPRResult {
  prUrl: string;
  prNumber: number;
  branchName: string;
}

/**
 * Create a PR on visquanta-dev/site with the draft content and images.
 * Branch: ultraplan/<yyyy-mm-dd>-<slug>
 * Labels: lane:*, funnel:*, ultraplan-draft, ready-for-review
 */
export async function createDraftPR(input: CreateDraftPRInput): Promise<CreateDraftPRResult> {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const ts = now.getTime().toString(36); // short unique suffix
  const branchName = `ultraplan/${date}-${input.slug}-${ts}`;

  // 1. Create branch
  await createBranch(branchName);

  // 2. Upload markdown
  const mdPath = `content/blog/${input.slug}.md`;
  await upsertFile(branchName, mdPath, input.markdownContent, `feat(blog): add ${input.slug} draft`);

  // 3. Upload images
  for (const img of input.images) {
    const imageBuffer = fs.readFileSync(img.absolutePath);
    await upsertFile(
      branchName,
      img.relativePath,
      imageBuffer,
      `feat(blog): add image ${path.basename(img.relativePath)}`,
    );
  }

  // 4. Upload metadata (gate report + bundle summary)
  if (input.metadata) {
    const metaPath = `content/blog/_metadata/${input.slug}.json`;
    await upsertFile(
      branchName,
      metaPath,
      JSON.stringify(input.metadata, null, 2),
      `feat(blog): add metadata for ${input.slug}`,
    );
  }

  // 5. Create PR
  const laneLabel = `lane:${input.lane}`;
  const funnelMap = {
    daily_seo: 'funnel:tofu',
    weekly_authority: 'funnel:mofu',
    monthly_anonymized_case: 'funnel:bofu',
    listicle: 'funnel:tofu',
  } as const;
  const funnelLabel = funnelMap[input.lane];

  const sourceSummary = input.bundle.sources
    .map((s) => `- [${s.domain}](${s.url}) (${s.quotes.length} quotes)`)
    .join('\n');

  const gatesSummary = input.gateReport.results
    .map((r) => `| ${r.gate} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.aggregate_score ?? '-'} | ${r.summary.slice(0, 80)} |`)
    .join('\n');

  const heroWarning = input.heroFallbackUsed
    ? [
        '> ⚠️ **HERO IMAGE MISSING — REPLACE BEFORE MERGE**',
        '> ',
        '> The image pipeline failed all retries for this post. The frontmatter currently points at a generic fallback image so the post is not broken, but a real custom hero should be generated or uploaded before merging. See the `hero-missing` label.',
        '',
      ].join('\n')
    : '';

  const seoAeoWarning = input.seoAeoWarning
    ? [
        `> 📉 **SEO+AEO score ${input.seoAeoScore ?? '?'}% — below 85% target**`,
        '> ',
        '> The post passed the minimum gate (70%) but is in the warning band. Review the gate findings in the metadata JSON and fix any obvious weaknesses (missing TL;DR, non-question H2s, keyword density) before merging.',
        '',
      ].join('\n')
    : '';

  const seoAeoLine = typeof input.seoAeoScore === 'number'
    ? `**SEO+AEO score:** ${input.seoAeoScore}/100`
    : '';

  // Build the hero image options section if multi-option images are available.
  // Images use GitHub blob URL with ?raw=true which works for private repos
  // (raw.githubusercontent.com returns 404 on private repos).
  const BLOB_BASE = `https://github.com/${TARGET_REPO}/blob`;
  let imageOptionsSection = '';
  if (input.imageOptions && input.imageOptions.length > 0) {
    const lines: string[] = [
      '### Hero Image Options',
      '',
      `Pick one hero image. Rename your choice to \`${input.slug}-hero.jpg\` and delete the rest before merging.`,
      '',
    ];
    for (const opt of input.imageOptions) {
      const sourceLabel = opt.source === 'ai'
        ? 'AI Generated'
        : `Pexels — Photo by ${opt.photographer ?? 'Unknown'}`;
      // Convert local relative path to repo-relative path (forward slashes, no leading slash).
      const toRepoPath = (relPath: string) => relPath.replace(/\\/g, '/').replace(/^\//, '');
      const baseUrl = `${BLOB_BASE}/${branchName}/${toRepoPath(opt.path)}?raw=true`;
      const overlayUrl = `${BLOB_BASE}/${branchName}/${toRepoPath(opt.overlayPath)}?raw=true`;
      lines.push(
        `**Option ${opt.label}** (${sourceLabel})`,
        `![Option ${opt.label}](${baseUrl})`,
        `![Option ${opt.label} with overlay](${overlayUrl})`,
        '',
      );
    }
    imageOptionsSection = lines.join('\n');
  }

  const body = [
    '## UltraPlan Draft',
    '',
    heroWarning,
    seoAeoWarning,
    `**Lane:** ${input.lane}`,
    `**Slug:** ${input.slug}`,
    `**Verdict:** ${input.gateReport.verdict}`,
    `**Attempt:** ${input.gateReport.attempt}`,
    seoAeoLine,
    '',
    '### Sources',
    sourceSummary,
    '',
    '### Gate Report',
    '| Gate | Result | Score | Summary |',
    '|------|--------|-------|---------|',
    gatesSummary,
    '',
    imageOptionsSection,
    '---',
    '*Generated by UltraPlan. Review the draft in `content/blog/` and merge when ready.*',
  ].join('\n');

  const prRes = await ghFetch(`/repos/${TARGET_REPO}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `[UltraPlan] ${input.slug}`,
      body,
      head: branchName,
      base: 'main',
    }),
  });

  if (!prRes.ok) {
    const text = await prRes.text();
    throw new Error(`[github] Failed to create PR: ${prRes.status} ${text}`);
  }

  const pr = await prRes.json() as { html_url: string; number: number };

  // 6. Add labels (best-effort, don't fail if labels don't exist)
  const labels = [laneLabel, funnelLabel, 'ultraplan-draft', 'ready-for-review'];
  if (input.heroFallbackUsed) {
    labels.push('hero-missing');
  }
  if (input.seoAeoWarning) {
    labels.push('seo-aeo-warning');
  }
  await ghFetch(`/repos/${TARGET_REPO}/issues/${pr.number}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  }).catch(() => { /* labels may not exist yet */ });

  return {
    prUrl: pr.html_url,
    prNumber: pr.number,
    branchName,
  };
}
