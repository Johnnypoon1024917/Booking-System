import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

// Single source of truth for the "Region" dropdowns. Regions are defined on
// Locations (each location carries a region), managed by admins under
// Admin → Locations — so the canonical region list is the distinct set of
// region values across the tenant's locations.
//
// The resource editor used to hard-code ['Hong Kong', 'Kowloon', 'New
// Territories'] while the user editor derived its list from locations, so the
// two never matched and a region an admin actually configured couldn't be
// assigned to a room (QA #7). Both now read from here. The hard-coded trio is
// kept only as a seed for a brand-new tenant that hasn't defined any locations
// yet, so the dropdown is never empty.
const SEED_REGIONS = ['Hong Kong', 'Kowloon', 'New Territories'];

export function useRegions(extra: string[] = []): string[] {
  const [locationRegions, setLocationRegions] = useState<string[]>([]);
  useEffect(() => {
    api.locations()
      .then((locs: any[]) => setLocationRegions(
        [...new Set((locs || []).map((l) => l.region).filter(Boolean))] as string[],
      ))
      .catch(() => setLocationRegions([]));
  }, []);
  const extraKey = extra.filter(Boolean).join('|');
  return useMemo(() => {
    // Configured location regions are authoritative; fall back to the seed only
    // when none exist yet. The current value (extra) is always kept so editing a
    // room whose region predates the catalog never drops its own value.
    const base = locationRegions.length ? locationRegions : SEED_REGIONS;
    const set = new Set<string>(base);
    extra.forEach((v) => { if (v) set.add(v); });
    return [...set].sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationRegions, extraKey]);
}
