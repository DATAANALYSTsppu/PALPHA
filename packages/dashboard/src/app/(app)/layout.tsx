'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { RouteGuard } from '@/lib/route-guard';
import { authApi, type AuthUser } from '@/lib/api';

export default function AppLayout({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi
      .me()
      .then((u) => setUser(u))
      .catch(() => {
        // In dev mode with override headers set, fall back to a local user.
        // Otherwise, the api.ts client has already redirected to the SSO login.
        if (process.env.NEXT_PUBLIC_DEV_USER_ID && process.env.NEXT_PUBLIC_DEV_ROLE) {
          setUser({
            id: process.env.NEXT_PUBLIC_DEV_USER_ID,
            externalId: process.env.NEXT_PUBLIC_DEV_USER_ID,
            email: process.env.NEXT_PUBLIC_DEV_USER_EMAIL ?? 'dev@local',
            name: process.env.NEXT_PUBLIC_DEV_USER_NAME ?? 'Dev User',
            role: 'admin',
          });
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center animate-pulse">
          <span className="text-primary-foreground text-xs font-bold">pA</span>
        </div>
      </div>
    );
  }

  // If still no user after dev override fallback, something is misconfigured —
  // api.ts already redirected to SSO so we should never get here in production.
  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Redirecting to login…</p>
      </div>
    );
  }

  return (
    <AppShell user={{ name: user.name, email: user.email }}>
      <RouteGuard userRole={user.role}>{children}</RouteGuard>
    </AppShell>
  );
}
