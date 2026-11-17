// Memory that lives as long as the application and is filled by what happens (pages, downloads, workers) gets a ceiling: past it the oldest
// entries go. The collections below are caches or memories of a recent event, so forgetting the oldest costs a lookup, never a result.

/** Puts `key` in the map as the newest entry; the oldest ones go while the map holds more than `max`. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  // A key that is set again moves to the end of the order the map remembers.
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/** Adds `value` to the set as the newest entry; the oldest ones go while the set holds more than `max`. */
export function addBounded<T>(set: Set<T>, value: T, max: number): void {
  set.delete(value)
  set.add(value)
  while (set.size > max) {
    const oldest = set.values().next()
    if (oldest.done) break
    set.delete(oldest.value)
  }
}
