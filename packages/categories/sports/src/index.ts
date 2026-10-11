import type { PolyEvent, ClassifiedEvent, CategoryPlugin } from '@polymarket-bot/core';
import { classifySportsEvent } from './classifier.js';
import { SPORTS_TAGS, SPORTS_KEYWORDS, TITLE_BLACKLIST } from './config.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const sportsPlugin: CategoryPlugin = {
  name: 'sports',
  tags: SPORTS_TAGS,
  keywords: SPORTS_KEYWORDS,
  blacklist: TITLE_BLACKLIST,

  classifyEvent(event: PolyEvent): ClassifiedEvent | null {
    return classifySportsEvent(event);
  },

  isMatchingEvent(event: PolyEvent): boolean {
    const title = (event.title || '').toLowerCase();
    const eventTags = (event.tags || []).map(t => t.label.toLowerCase());

    for (const bl of this.blacklist) {
      if (title.includes(bl.toLowerCase())) return false;
    }

    const tagsLower = this.tags.map(t => t.toLowerCase());
    if (eventTags.some(t => tagsLower.includes(t))) return true;

    for (const keywords of Object.values(this.keywords)) {
      if (keywords.some(kw => title.includes(kw.toLowerCase()))) return true;
    }

    return false;
  },

  getMigrationDir(): string {
    return join(__dirname, '..', 'src', 'migrations');
  },

  getExtraScoring() {
    return { diversityField: 'subcategory', diversityWeight: 0.03 };
  },
};

export default sportsPlugin;
