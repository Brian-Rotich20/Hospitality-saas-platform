export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure:   true,
    sameSite: 'none' as const,
    maxAge:   60 * 60 * 24 * 7,
    path:     '/',
  };
}

export function clearRefreshCookieOptions() {
  // Must match the SAME attributes used when setting it (minus maxAge),
  // or the browser won't reliably match+delete the original cookie.
  return {
    httpOnly: true,
    secure:   true,
    sameSite: 'none' as const,
    path:     '/',
  };
}