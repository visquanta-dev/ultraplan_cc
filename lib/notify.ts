// ---------------------------------------------------------------------------
// Slack notifications — spec §8 failure modes
// Fires on PR creation failure (after 3 retries) and blocked drafts.
// Uses a simple incoming webhook — no Slack SDK needed.
// ---------------------------------------------------------------------------

interface SlackMessage {
  text: string;
  blocks?: Array<{
    type: string;
    text?: { type: string; text: string };
    fields?: Array<{ type: string; text: string }>;
  }>;
}

function getWebhookUrl(): string | null {
  return process.env.SLACK_WEBHOOK_URL || null;
}

async function send(message: SlackMessage): Promise<boolean> {
  const url = getWebhookUrl();
  if (!url) {
    console.warn('[slack] SLACK_WEBHOOK_URL not set — notification skipped');
    return false;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    return res.ok;
  } catch (err) {
    console.error('[slack] notification failed:', err);
    return false;
  }
}

export async function notifyPipelineBlocked(
  slug: string,
  lane: string,
  reason: string,
): Promise<void> {
  await send({
    text: `🚫 UltraPlan draft blocked: ${slug}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Draft Blocked*: \`${slug}\`` },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Lane:* ${lane}` },
          { type: 'mrkdwn', text: `*Reason:* ${reason}` },
        ],
      },
    ],
  });
}

export async function notifyPRCreationFailed(
  slug: string,
  error: string,
): Promise<void> {
  await send({
    text: `⚠️ UltraPlan PR creation failed: ${slug} — ${error}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*PR Creation Failed*: \`${slug}\`\n\`\`\`${error.slice(0, 500)}\`\`\``,
        },
      },
    ],
  });
}

export async function notifyPipelineComplete(
  slug: string,
  lane: string,
  prUrl: string,
): Promise<void> {
  await send({
    text: `✅ UltraPlan draft ready for review: ${slug}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Draft Ready*: <${prUrl}|${slug}>\n*Lane:* ${lane}`,
        },
      },
    ],
  });
}
