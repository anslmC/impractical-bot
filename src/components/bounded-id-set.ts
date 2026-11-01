export interface BoundedIdSet {
  add(id: string): void;
  has(id: string): boolean;
  clear(): void;
  values(): string[];
  readonly size: number;
}

export function createBoundedIdSet(limit: number): BoundedIdSet {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive integer.');
  }

  const ids = new Set<string>();

  return {
    add(id) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('id must be a non-empty string.');
      }
      if (ids.has(id)) {
        return;
      }
      ids.add(id);
      while (ids.size > limit) {
        const oldestId = ids.values().next().value;
        if (oldestId === undefined) {
          break;
        }
        ids.delete(oldestId);
      }
    },
    has(id) {
      return ids.has(id);
    },
    clear() {
      ids.clear();
    },
    values() {
      return [...ids.values()];
    },
    get size() {
      return ids.size;
    },
  };
}
