import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// GitHub PR webhook — spec §8-9
// Receives PR events from GitHub and triggers the appropriate workflow
// action: merge → post-publish, request_changes → regen, close → reject.
// ---------------------------------------------------------------------------

const REJECTION_LOG_PATH = path.join(process.cwd(), 'data', 'rejection_log.jsonl');

interface PRWebhookPayload {
  action: string;
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    merged: boolean;
    head: { ref: string };
    labels: Array<{ name: string }>;
    body: string | null;
  };
  sender: { login: string };
  review?: {
    state: string;
    body: string | null;
  };
}

function verifySignature(body: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(body, 'utf-8')
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}

function isUltraPlanPR(payload: PRWebhookPayload): boolean {
  return (
    payload.pull_request.head.ref.startsWith('ultraplan/') ||
    payload.pull_request.labels.some((l) => l.name === 'ultraplan-draft')
  );
}

function extractSlugFromBranch(branch: string): string {
  // ultraplan/2026-04-10-after-hours-ai-coverage → after-hours-ai-coverage
  const match = branch.match(/^ultraplan\/\d{4}-\d{2}-\d{2}-(.+)$/);
  return match ? match[1] : branch.replace('ultraplan/', '');
}

function extractLaneFromLabels(
  labels: Array<{ name: string }>,
): string | null {
  const laneLabel = labels.find((l) => l.name.startsWith('lane:'));
  return laneLabel ? laneLabel.name.replace('lane:', '') : null;
}

function extractRejectionReason(
  labels: Array<{ name: string }>,
  body: string | null,
): string {
  const reasonLabel = labels.find((l) => l.name.startsWith('rejection_reason:'));
  if (reasonLabel) return reasonLabel.name.replace('rejection_reason:', '').trim();
  if (body) return body.slice(0, 500);
  return 'No reason provided';
}

/**
 * Append a rejection entry to data/rejection_log.jsonl.
 */
function logRejection(entry: {
  date: string;
  slug: string;
  lane: string | null;
  reason: string;
  feedback: string;
  reviewer: string;
  pr_url: string;
}): void {
  const dir = path.dirname(REJECTION_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(REJECTION_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  // Verify webhook signature
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = request.headers.get('x-github-event');
  const payload = JSON.parse(rawBody) as PRWebhookPayload;

  // Only process UltraPlan PRs
  if (!isUltraPlanPR(payload)) {
    return NextResponse.json({ skipped: true, reason: 'not an ultraplan PR' });
  }

  const slug = extractSlugFromBranch(payload.pull_request.head.ref);
  const lane = extractLaneFromLabels(payload.pull_request.labels);

  // Handle PR closed (merged or rejected)
  if (event === 'pull_request' && payload.action === 'closed') {
    if (payload.pull_request.merged) {
      // MERGED — trigger post-publish workflow
      console.log(`[webhook] PR #${payload.pull_request.number} merged: ${slug}`);

      // TODO(phase-10): trigger Vercel Workflow step 9 (post-publish)
      // For now, log the event
      return NextResponse.json({
        action: 'merged',
        slug,
        lane,
        message: 'Post-publish workflow will be triggered in Phase 10',
      });
    } else {
      // CLOSED without merging — rejection
      const reason = extractRejectionReason(
        payload.pull_request.labels,
        payload.pull_request.body,
      );

      logRejection({
        date: new Date().toISOString().split('T')[0],
        slug,
        lane,
        reason,
        feedback: reason,
        reviewer: payload.sender.login,
        pr_url: payload.pull_request.html_url,
      });

      console.log(`[webhook] PR #${payload.pull_request.number} rejected: ${slug} — ${reason}`);

      return NextResponse.json({
        action: 'rejected',
        slug,
        lane,
        reason,
        message: 'Rejection logged to data/rejection_log.jsonl',
      });
    }
  }

  // Handle PR review with changes_requested → regen
  if (event === 'pull_request_review' && payload.review?.state === 'changes_requested') {
    const feedback = payload.review.body ?? 'Changes requested without specific feedback';

    console.log(`[webhook] PR #${payload.pull_request.number} changes requested: ${slug}`);

    // TODO(phase-10): trigger Vercel Workflow regen step with feedback
    return NextResponse.json({
      action: 'regen_requested',
      slug,
      lane,
      feedback,
      message: 'Regen workflow will be triggered in Phase 10',
    });
  }

  // Handle PR with 'regenerate' label added
  if (event === 'pull_request' && payload.action === 'labeled') {
    const hasRegenLabel = payload.pull_request.labels.some(
      (l) => l.name === 'regenerate',
    );
    if (hasRegenLabel) {
      console.log(`[webhook] PR #${payload.pull_request.number} regenerate label: ${slug}`);

      return NextResponse.json({
        action: 'regen_requested',
        slug,
        lane,
        message: 'Regen workflow will be triggered in Phase 10',
      });
    }
  }

  return NextResponse.json({ skipped: true, reason: 'unhandled event/action' });
}
