// ---------------------------------------------------------------------------
// Pexels stock photo client
// Searches Pexels API for landscape photos and downloads them as Buffers.
// Auth: Authorization: <key> (no Bearer prefix)
// ---------------------------------------------------------------------------

const PEXELS_BASE_URL = 'https://api.pexels.com/v1';

export interface PexelsPhoto {
  id: number;
  url: string;           // Pexels page URL
  photographer: string;
  photographerUrl: string;
  src: string;           // Direct image URL (large2x, ~1880px wide)
  alt: string;
  width: number;
  height: number;
}

interface PexelsSearchOptions {
  perPage?: number;
  page?: number;
}

interface PexelsApiPhoto {
  id: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  width: number;
  height: number;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
}

interface PexelsSearchResponse {
  total_results: number;
  page: number;
  per_page: number;
  photos: PexelsApiPhoto[];
  next_page?: string;
}

function getApiKey(): string {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error('[pexels] PEXELS_API_KEY is not set.');
  return key;
}

/**
 * Search Pexels for landscape photos matching a query.
 * Returns only landscape-oriented photos (width > height), preferring width >= 1200.
 */
export async function searchPhotos(
  query: string,
  options: PexelsSearchOptions = {}
): Promise<PexelsPhoto[]> {
  const { perPage = 10, page = 1 } = options;
  const apiKey = getApiKey();

  const params = new URLSearchParams({
    query,
    orientation: 'landscape',
    size: 'large',
    per_page: String(perPage),
    page: String(page),
  });

  const response = await fetch(`${PEXELS_BASE_URL}/search?${params}`, {
    headers: {
      Authorization: apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`[pexels] Search failed: ${response.status} ${response.statusText}`);
  }

  const data: PexelsSearchResponse = await response.json();

  // Filter to landscape only (width > height) and prefer width >= 1200
  const photos = data.photos
    .filter((p) => p.width > p.height)
    .sort((a, b) => {
      const aPreferred = a.width >= 1200 ? 1 : 0;
      const bPreferred = b.width >= 1200 ? 1 : 0;
      return bPreferred - aPreferred;
    })
    .map((p): PexelsPhoto => ({
      id: p.id,
      url: p.url,
      photographer: p.photographer,
      photographerUrl: p.photographer_url,
      src: p.src.large2x || p.src.original,
      alt: p.alt,
      width: p.width,
      height: p.height,
    }));

  console.log(`[pexels] Found ${photos.length} photos for "${query}"`);
  return photos;
}

/**
 * Download a photo from a URL and return its content as a Buffer.
 * Sends the Pexels API key in the Authorization header (required for Pexels CDN).
 */
export async function downloadPhoto(photoUrl: string): Promise<Buffer> {
  const apiKey = getApiKey();

  const response = await fetch(photoUrl, {
    headers: {
      Authorization: apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`[pexels] Download failed: ${response.status} ${response.statusText} — ${photoUrl}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Convenience: search Pexels, take the top `count` results, download them, and return
 * an array of { photo, buffer } pairs.
 */
export async function searchAndDownload(
  query: string,
  count = 2
): Promise<{ photo: PexelsPhoto; buffer: Buffer }[]> {
  const photos = await searchPhotos(query, { perPage: Math.max(count * 2, 10) });
  const selected = photos.slice(0, count);

  const results = await Promise.all(
    selected.map(async (photo) => {
      const buffer = await downloadPhoto(photo.src);
      return { photo, buffer };
    })
  );

  return results;
}
