import type { HoursMethod, WeeklyHours } from '../types.js';

export type HoursConfidence = 'high' | 'medium' | 'low';

export const CONFIDENCE_RANK: Record<HoursConfidence, number> = { high: 3, medium: 2, low: 1 };

export interface HoursCandidate {
  weekly: WeeklyHours;
  method: HoursMethod;
  confidence: HoursConfidence;
  /** Source strings kept as evidence for the report. */
  raw: string[];
}

/** Name, address, and phone scraped from the site, used to resolve its Google listing. */
export interface SiteIdentity {
  name: string | null;
  address: string | null;
  telephone: string | null;
  /** Where the name came from: structured data is trusted over a page title. */
  source?: 'structured' | 'title';
}

/** Raw microdata harvested from the page; interpretation happens in `parse-microdata.ts`. */
export interface MicrodataHours {
  /** `itemprop="openingHours"` values, in the schema.org shorthand grammar. */
  openingHours: string[];
  /** `OpeningHoursSpecification` itemscopes. */
  specs: Array<{ days: string[]; opens: string; closes: string }>;
}
