import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Admin basic auth — spec §8
// Single-user basic auth for /admin and /api/admin routes.
// ---------------------------------------------------------------------------

/**
 * Verify basic auth credentials from request headers.
 * Returns null if valid, or a 401 response if invalid.
 */
export function requireAuth(request: NextRequest): NextResponse | null {
  const user = process.env.ADMIN_BASIC_AUTH_USER;
  const pass = process.env.ADMIN_BASIC_AUTH_PASS;

  if (!user || !pass) {
    return NextResponse.json(
      { error: 'Admin auth not configured' },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Basic ')) {
    return new NextResponse('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="UltraPlan Admin"' },
    });
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [providedUser, providedPass] = credentials.split(':');

  if (providedUser !== user || providedPass !== pass) {
    return new NextResponse('Invalid credentials', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="UltraPlan Admin"' },
    });
  }

  return null; // Auth passed
}
