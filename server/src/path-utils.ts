import path from "node:path";

/**
 * Safe path root check: true only when p equals root or is a child of root.
 * This avoids treating /foo-bar as being inside /foo.
 */
export function pathStartsWithRoot(p: string, root: string): boolean {
  if (!root) return false;
  const normalizedRoot = root.endsWith(path.sep)
    ? root.slice(0, -path.sep.length)
    : root;
  if (!normalizedRoot) return false;
  return p === normalizedRoot || p.startsWith(`${normalizedRoot}${path.sep}`);
}

/**
 * Return [cwd, cwd-parent, ...] until homeDir, excluding homeDir and fs root.
 */
export function computeAncestorChain(cwd: string, homeDir: string): string[] {
  const result: string[] = [];
  const resolvedHome = path.resolve(homeDir);
  let current = path.resolve(cwd);

  while (current !== resolvedHome) {
    const parent = path.dirname(current);
    if (parent === current) break;
    result.push(current);
    current = parent;
  }

  return result;
}
