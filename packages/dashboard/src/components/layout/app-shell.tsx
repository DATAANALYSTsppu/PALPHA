import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import type { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
  user?: { name: string; email: string };
}

export function AppShell({ children, user }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar user={user} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
