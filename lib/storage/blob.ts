import { put, list, del, head } from '@vercel/blob';

// ---------------------------------------------------------------------------
// Vercel Blob storage layer
// Replaces local filesystem (data/runs/, data/blocked/, data/rejection_log)
// with serverless-compatible persistent storage.
//
// Blob paths mirror the old filesystem layout:
//   runs/<date>-<slug>.json
//   blocked/<slug>.json
//   rejection_log.jsonl
// ---------------------------------------------------------------------------

const STORE_ID = process.env.BLOB_READ_WRITE_TOKEN ? undefined : undefined;

/**
 * Write a JSON object to Vercel Blob.
 */
export async function writeJson(
  pathname: string,
  data: unknown,
): Promise<string> {
  const blob = await put(pathname, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return blob.url;
}

/**
 * Read a JSON object from Vercel Blob by pathname.
 * Returns null if not found.
 */
export async function readJson<T = unknown>(
  pathname: string,
): Promise<T | null> {
  try {
    const meta = await head(pathname);
    if (!meta) return null;
    const res = await fetch(meta.url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * List all blobs under a given prefix.
 * Returns blob metadata sorted by pathname.
 */
export async function listByPrefix(
  prefix: string,
  options: { limit?: number } = {},
): Promise<Array<{ pathname: string; url: string; uploadedAt: Date }>> {
  const { limit = 100 } = options;
  const result = await list({ prefix, limit });
  return result.blobs.map((b) => ({
    pathname: b.pathname,
    url: b.url,
    uploadedAt: b.uploadedAt,
  }));
}

/**
 * Delete a blob by its URL.
 */
export async function deleteBlob(url: string): Promise<void> {
  await del(url);
}

/**
 * Append a line to a JSONL file stored in Vercel Blob.
 * Since Blob doesn't support append, we read → append → write.
 */
export async function appendJsonl(
  pathname: string,
  entry: unknown,
): Promise<void> {
  let existing = '';
  try {
    const meta = await head(pathname);
    if (meta) {
      const res = await fetch(meta.url);
      if (res.ok) existing = await res.text();
    }
  } catch {
    // File doesn't exist yet — start fresh
  }

  const newContent = existing
    ? `${existing.trimEnd()}\n${JSON.stringify(entry)}\n`
    : `${JSON.stringify(entry)}\n`;

  await put(pathname, newContent, {
    access: 'public',
    contentType: 'application/x-ndjson',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/**
 * Read a JSONL file and parse all entries.
 * Returns an empty array if the file doesn't exist.
 */
export async function readJsonl<T = unknown>(
  pathname: string,
): Promise<T[]> {
  try {
    const meta = await head(pathname);
    if (!meta) return [];
    const res = await fetch(meta.url);
    if (!res.ok) return [];
    const text = await res.text();
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line) as T; }
        catch { return null; }
      })
      .filter((entry): entry is T => entry !== null);
  } catch {
    return [];
  }
}
