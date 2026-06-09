import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

// Single source of truth for the asset-type dropdowns shown by the resource
// editor and the approval-rule scope picker. The two used to keep their own
// hard-coded arrays — the editor listed "Conference" while the approval picker
// didn't — so a rule could never target a resource of that type and the lists
// visibly disagreed (QA #11). Both now build from this hook: the admin-managed
// resource-type catalog, unioned with the built-ins (a usable fallback before
// the catalog loads) and any extra values the caller already has in hand
// (e.g. the value currently selected, so it never vanishes from its own list).
export const BUILTIN_ASSET_TYPES = ['Meeting Room', 'Conference', 'Top Management', 'Equipment', 'Vehicle'];

export function useAssetTypes(extra: string[] = []): string[] {
  const [types, setTypes] = useState<any[]>([]);
  useEffect(() => {
    api.resourceTypes().then((r) => setTypes(Array.isArray(r) ? r : [])).catch(() => setTypes([]));
  }, []);
  const extraKey = extra.filter(Boolean).join('|');
  return useMemo(() => {
    const set = new Set<string>(BUILTIN_ASSET_TYPES);
    types.forEach((rt) => { const v = rt?.label || rt?.key; if (v) set.add(v); });
    extra.forEach((v) => { if (v) set.add(v); });
    return [...set];
    // extraKey captures the contents of `extra` for the memo without depending
    // on a new array identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, extraKey]);
}
