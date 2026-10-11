import type { CategoryPlugin } from './types.js';

const plugins = new Map<string, CategoryPlugin>();

export function registerCategory(plugin: CategoryPlugin): void {
  plugins.set(plugin.name, plugin);
}

export function getCategory(name: string): CategoryPlugin | undefined {
  return plugins.get(name);
}

export function getAllCategories(): CategoryPlugin[] {
  return Array.from(plugins.values());
}

export function getCategoryNames(): string[] {
  return Array.from(plugins.keys());
}

/**
 * Load and register all built-in category plugins.
 */
export async function loadAllCategories(): Promise<void> {
  try {
    const { weatherPlugin } = await import('@polymarket-bot/category-weather');
    registerCategory(weatherPlugin);
  } catch {
    // Weather plugin not available
  }

  try {
    const { sportsPlugin } = await import('@polymarket-bot/category-sports');
    registerCategory(sportsPlugin);
  } catch {
    // Sports plugin not available
  }
}
