import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("package scripts keep brain:up on a force-recreate path", async () => {
  const packageJson = JSON.parse(await readFile(path.join(WORKDIR, "package.json"), "utf8"));
  const brainUp = packageJson?.scripts?.["brain:up"];

  assert.equal(typeof brainUp, "string");
  assert.match(brainUp, /\bdocker compose up\b/);
  assert.match(brainUp, /\s--build\b/);
  assert.match(brainUp, /\s--force-recreate\b/);
  assert.match(brainUp, /\s--remove-orphans\b/);
  assert.match(brainUp, /\s-d\b/);
});
