'use client';

/**
 * React hook for fetching from the API. Uses the cookie-based api client
 * (credentials: 'include'), so SSO session is forwarded automatically.
 * On 401 the api client redirects to NEXT_PUBLIC_AUTH_REDIRECT_URL.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from './api';

export function useApi<T>(path: string, refreshInterval = 30000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const result = await api.get<T>(path);
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    fetchData();
    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [fetchData, refreshInterval]);

  return { data, error, loading, refresh: fetchData };
}
