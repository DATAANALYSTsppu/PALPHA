'use client';

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn, shortenAddress } from '@/lib/utils';

interface CopyAddressProps {
  address: string;
  className?: string;
  /** Number of chars to show on each side of the address. Default 4. */
  chars?: number;
  /** Hide the truncated address (icon-only). Default false. */
  iconOnly?: boolean;
}

export function CopyAddress({ address, className, chars = 4, iconOnly = false }: CopyAddressProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable in insecure contexts
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'group inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors font-mono',
        className
      )}
      title={copied ? 'Copied!' : `Copy ${address}`}
    >
      {!iconOnly && <span>{shortenAddress(address, chars)}</span>}
      {copied ? (
        <Check className="h-3 w-3 text-positive" />
      ) : (
        <Copy className="h-3 w-3 opacity-60 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  );
}
