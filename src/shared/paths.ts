/** Canonical path helpers. '$' is the document root; segments look like [0], ["key"] or .name. */
export const ROOT_PATH = '$';

/**
 * Return a path and every container above it.
 *   $.orders[key="O-1"].amount.value
 * -> [ itself, $.orders[key="O-1"].amount, $.orders[key="O-1"], $.orders, $ ]
 */
export function bucketPaths(path: string): string[] {
  const buckets = new Set<string>();
  buckets.add(path);
  let current = path;
  while (current !== ROOT_PATH) {
    const lastDot = current.lastIndexOf('.');
    const lastBracket = current.lastIndexOf('[');
    if (lastDot > lastBracket) {
      // Object property: strip ".name". Only treat as separator when the dot
      // is outside brackets (it is, since it's after the last '[').
      const parent = current.slice(0, lastDot);
      if (parent === current || parent.length === 0) break;
      buckets.add(parent);
      current = parent;
    } else if (lastBracket > 0) {
      // Array/keyed element: strip "[...]".
      const parent = current.slice(0, lastBracket);
      if (parent.length === 0) break;
      buckets.add(parent);
      current = parent;
    } else {
      break;
    }
  }
  buckets.add(ROOT_PATH);
  return [...buckets];
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function joinPath(parent: string, key: string | number): string {
  if (typeof key === 'number' || !IDENTIFIER.test(key)) {
    return `${parent}[${typeof key === 'number' ? key : JSON.stringify(key)}]`;
  }
  return `${parent}.${key}`;
}
