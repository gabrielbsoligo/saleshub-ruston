import { useMemo } from 'react';

export interface GroupResult<T> {
  key: string;
  items: T[];
  aggs: Record<string, number>;
}

/**
 * Generic grouping + aggregation hook.
 * @param items list of records
 * @param keyFn function returning a stable group key
 * @param aggFns map of aggregation name -> reducer over the group's items
 * @param sortBy optional aggregation key to sort groups by (descending)
 */
export function useGroupBy<T>(
  items: T[],
  keyFn: (item: T) => string,
  aggFns: Record<string, (items: T[]) => number>,
  sortBy?: string,
): GroupResult<T>[] {
  return useMemo(() => {
    const map: Record<string, T[]> = {};
    for (const item of items) {
      const k = keyFn(item) || '—';
      (map[k] ||= []).push(item);
    }
    const groups: GroupResult<T>[] = Object.entries(map).map(([key, groupItems]) => {
      const aggs: Record<string, number> = {};
      for (const [name, fn] of Object.entries(aggFns)) aggs[name] = fn(groupItems);
      return { key, items: groupItems, aggs };
    });
    if (sortBy) groups.sort((a, b) => (b.aggs[sortBy] || 0) - (a.aggs[sortBy] || 0));
    else groups.sort((a, b) => a.key.localeCompare(b.key));
    return groups;
  }, [items, keyFn, aggFns, sortBy]);
}
