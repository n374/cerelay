import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

let caseSensitive: boolean | null = null;

export function probeCaseSensitivity(probeDir?: string): boolean {
  if (caseSensitive !== null) return caseSensitive;
  const dir = probeDir ?? process.env.CERELAY_DATA_DIR ?? "/tmp";
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const upper = path.join(dir, ".case-probe-Foo.tmp");
  const lower = path.join(dir, ".case-probe-foo.tmp");
  try {
    writeFileSync(upper, "x");
    caseSensitive = !existsSync(lower) || statSync(upper).ino !== statSync(lower).ino;
  } catch {
    caseSensitive = true;
  } finally {
    try {
      rmSync(upper, { force: true });
    } catch {
      // best-effort cleanup
    }
    try {
      rmSync(lower, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
  return caseSensitive;
}

export function resetCaseSensitivityForTest(value?: boolean): void {
  caseSensitive = value ?? null;
}

export function normalizeLedgerPath(absPath: string): string {
  if (!path.isAbsolute(absPath)) {
    throw new Error(`normalizeLedgerPath requires absolute path: ${absPath}`);
  }

  const parent = path.dirname(absPath);
  const basename = path.basename(absPath);
  let resolvedParent: string;
  try {
    resolvedParent = realpathSync.native(parent);
  } catch {
    resolvedParent = parent;
  }

  const normalizedBasename = (caseSensitive ?? probeCaseSensitivity())
    ? basename
    : basename.toLowerCase();
  return path.join(resolvedParent, normalizedBasename);
}
