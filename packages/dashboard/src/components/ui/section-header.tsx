import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function SectionHeader({
  title,
  subtitle,
  actions,
  className,
  size = 'md',
}: SectionHeaderProps) {
  const titleSizes = {
    sm: 'text-base font-semibold',
    md: 'text-lg font-semibold',
    lg: 'text-2xl font-bold',
  };
  const subtitleSizes = { sm: 'text-xs', md: 'text-sm', lg: 'text-base' };

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className={cn(titleSizes[size], 'text-foreground')}>{title}</h2>
        {subtitle && (
          <p className={cn(subtitleSizes[size], 'text-muted-foreground mt-0.5')}>{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
