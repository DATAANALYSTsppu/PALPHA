import type { PolyEvent, ClassifiedEvent } from '@polymarket-bot/core';

const TEMP_PATTERN = /highest temperature in (\w+(?:\s\w+)*?) on (.+)\?/i;
const TEMP_PATTERN2 = /lowest temperature in (\w+(?:\s\w+)*?) on (.+)\?/i;
const SNOW_PATTERN = /(?:will it )?snow in (.+?) on (.+)\?/i;
const RAIN_PATTERN = /(?:will it )?rain in (.+?) on (.+)\?/i;
const SUNNY_PATTERN = /sunny in (.+?) (?:at|on) (.+)\?/i;

const HURRICANE_KEYWORDS = ['hurricane', 'tropical storm', 'tropical system', 'named storm'];
const CLIMATE_RECORD_KEYWORDS = ['hottest', 'warmest', 'coldest', 'record'];
const CLIMATE_KEYWORDS = ['arctic sea ice', 'sea ice extent', 'global temp', 'temperature increase'];

const CITY_ALIASES: Record<string, string> = {
  'nyc': 'NYC',
  'new york': 'NYC',
  "new york's central park": 'NYC',
  'london': 'London',
  'washington dc': 'Washington DC',
  'dc': 'Washington DC',
};

function normalizeCity(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return CITY_ALIASES[lower] || raw.trim();
}

function parseDateFromTitle(dateStr: string, endDateStr: string): string | undefined {
  const cleaned = dateStr.replace(/\?/g, '').trim();
  const endDate = new Date(endDateStr);
  const year = endDate.getFullYear();
  const d = new Date(`${cleaned}, ${year}`);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  const d2 = new Date(`${cleaned} ${year}`);
  if (!isNaN(d2.getTime())) return d2.toISOString().split('T')[0];
  return undefined;
}

export function classifyWeatherEvent(event: PolyEvent): ClassifiedEvent | null {
  const title = event.title || '';
  const titleLower = title.toLowerCase();
  const tags = (event.tags || []).map(t => t.label);

  let city: string | undefined;
  let subcategory = 'other_weather';

  let match = title.match(TEMP_PATTERN) || title.match(TEMP_PATTERN2);
  if (match) {
    city = normalizeCity(match[1]);
    subcategory = 'temperature';
  }

  if (!match) {
    match = title.match(SNOW_PATTERN) || title.match(RAIN_PATTERN) || title.match(SUNNY_PATTERN);
    if (match) {
      city = normalizeCity(match[1]);
      subcategory = 'daily_weather';
    }
  }

  if (!match && HURRICANE_KEYWORDS.some(kw => titleLower.includes(kw))) {
    subcategory = 'hurricane';
  }

  if (!match && CLIMATE_RECORD_KEYWORDS.some(kw => titleLower.includes(kw))) {
    subcategory = 'climate_record';
  }

  if (subcategory === 'other_weather' && CLIMATE_KEYWORDS.some(kw => titleLower.includes(kw))) {
    subcategory = 'climate';
  }

  return {
    polyEventId: parseInt(event.id, 10),
    title,
    slug: event.slug,
    description: event.description,
    endDate: event.endDate,
    category: 'weather',
    subcategory,
    subcategoryDetail: city,
    tags,
  };
}
