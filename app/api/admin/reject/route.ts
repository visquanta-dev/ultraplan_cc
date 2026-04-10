import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '../../../../lib/admin/auth';
import { readJsonl } from '../../../../lib/storage/blob';

// ---------------------------------------------------------------------------
// Admin API: Rejection log viewer — spec §8 (Vercel Blob storage)
// Reads rejection_log.jsonl from Vercel Blob.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const rejections = await readJsonl('rejection_log.jsonl');
  // Newest first
  rejections.reverse();

  return NextResponse.json({ rejections, count: rejections.length });
}
