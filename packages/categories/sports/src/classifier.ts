import type { PolyEvent, ClassifiedEvent } from '@polymarket-bot/core';
import { SPORTS_KEYWORDS, LEAGUE_PATTERNS, TAG_TO_SPORT, TITLE_BLACKLIST } from './config.js';

const VALID_SPORTS = ['NBA', 'NFL', 'MLB', 'NHL', 'UFC', 'Soccer', 'Cricket', 'Tennis', 'F1', 'Golf', 'Boxing', 'Other'];

export function classifySportsEvent(event: PolyEvent): ClassifiedEvent | null {
  const title = event.title || '';
  const titleLower = title.toLowerCase();
  const tags = (event.tags || []).map(t => t.label);

  // Check blacklist
  for (const bl of TITLE_BLACKLIST) {
    if (titleLower.includes(bl.toLowerCase())) return null;
  }

  // Try keyword matching (prefer longer/more specific matches)
  let detectedSport: string | null = null;
  let bestMatchLength = 0;

  for (const [sport, keywords] of Object.entries(SPORTS_KEYWORDS)) {
    for (const kw of keywords) {
      if (titleLower.includes(kw.toLowerCase()) && kw.length > bestMatchLength) {
        bestMatchLength = kw.length;
        detectedSport = sport;
      }
    }
  }

  // Fallback: check tags
  if (!detectedSport) {
    const tagLabels = tags.map(t => t.toLowerCase());
    for (const tag of tagLabels) {
      if (TAG_TO_SPORT[tag]) {
        detectedSport = TAG_TO_SPORT[tag];
        break;
      }
    }
    // Generic sports tag
    if (!detectedSport && tagLabels.some(t => ['sports', 'sport'].includes(t))) {
      detectedSport = 'Other';
    }
  }

  if (!detectedSport) return null;
  if (!VALID_SPORTS.includes(detectedSport)) detectedSport = 'Other';

  // Detect league
  let league: string | undefined;
  const patterns = LEAGUE_PATTERNS[detectedSport];
  if (patterns) {
    for (const [keyword, leagueName] of Object.entries(patterns)) {
      if (titleLower.includes(keyword.toLowerCase())) {
        league = leagueName;
        break;
      }
    }
  }

  return {
    polyEventId: parseInt(event.id, 10),
    title,
    slug: event.slug,
    description: event.description,
    endDate: event.endDate,
    category: 'sports',
    subcategory: detectedSport,
    subcategoryDetail: league,
    tags,
  };
}
