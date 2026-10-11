'use client';

import type { ReactNode } from 'react';

/**
 * Simple route guard. Since this product is admin-only, any authenticated user
 * (whose /auth/me succeeded) can access all routes. The guard is kept as a
 * scaffold for future multi-role expansion.
 */
export function RouteGuard({ children }: { children: ReactNode; userRole?: string }) {
  return <>{children}</>;
}
