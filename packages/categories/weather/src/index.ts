import type { PolyEvent, ClassifiedEvent, CategoryPlugin } from '@polymarket-bot/core';
import { classifyWeatherEvent } from './classifier.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const weatherPlugin: CategoryPlugin = {
  name: 'weather',
  tags: ['Weather', 'climate', 'Hurricanes', 'Hurricane Season'],
  keywords: {
    temperature: ['temperature', 'highest temp', 'lowest temp', 'hottest', 'coldest'],
    precipitation: ['rain', 'snow', 'sunny', 'precipitation'],
    hurricane: ['hurricane', 'tropical storm', 'tropical system', 'named storm'],
    climate: ['climate', 'arctic', 'sea ice', 'global temp'],
  },
  blacklist: ['Hurricanes vs', 'Mayweather', 'Weather Channel stock'],

  classifyEvent(event: PolyEvent): ClassifiedEvent | null {
    return classifyWeatherEvent(event);
  },

  isMatchingEvent(event: PolyEvent): boolean {
    const title = (event.title || '').toLowerCase();
    const eventTags = (event.tags || []).map(t => t.label.toLowerCase());

    // Check blacklist
    for (const bl of this.blacklist) {
      if (title.includes(bl.toLowerCase())) return false;
    }

    // Check tags
    if (eventTags.some(t => this.tags.map(s => s.toLowerCase()).includes(t))) return true;

    // Check keywords
    for (const keywords of Object.values(this.keywords)) {
      if (keywords.some(kw => title.includes(kw.toLowerCase()))) return true;
    }

    return false;
  },

  getMigrationDir(): string {
    return join(__dirname, '..', 'src', 'migrations');
  },

  getExtraScoring() {
    return { diversityField: 'subcategory_detail', diversityWeight: 0.10 };
  },
};

export default weatherPlugin;
