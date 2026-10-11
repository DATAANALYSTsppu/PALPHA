'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './theme-toggle';

interface TopBarProps {
  user?: { name: string; email: string };
  className?: string;
}

export function TopBar({ user, className }: TopBarProps) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initials = user?.name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <header
      className={cn(
        'h-16 flex items-center justify-between px-6 bg-surface border-b border-border shrink-0',
        className
      )}
    >
      <div /> {/* Left spacer (room for future fund/market selector) */}

      <div className="flex items-center gap-2 shrink-0">
        <ThemeToggle />

        {user && (
          <div className="relative pl-2 border-l border-border ml-1" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent transition-colors"
            >
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-primary text-xs font-semibold">{initials || '??'}</span>
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-sm font-medium text-foreground leading-none">{user.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">Admin</p>
              </div>
            </button>

            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-border bg-surface shadow-lg py-1 z-50">
                <div className="px-3 py-2">
                  <p className="text-sm font-medium text-foreground">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">Admin</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
