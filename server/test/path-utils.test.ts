import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeAncestorChain, pathStartsWithRoot } from "../src/path-utils.js";

describe("pathStartsWithRoot", () => {
  test("path === root returns true", () => {
    assert.equal(pathStartsWithRoot("/a/b", "/a/b"), true);
  });

  test("path under root returns true", () => {
    assert.equal(pathStartsWithRoot("/a/b/c", "/a/b"), true);
  });

  test("same prefix but not child path returns false", () => {
    assert.equal(pathStartsWithRoot("/a/bc", "/a/b"), false);
    assert.equal(pathStartsWithRoot("/foo-bar", "/foo"), false);
  });

  test("trailing separator on root is normalized", () => {
    assert.equal(pathStartsWithRoot("/a/b/c", "/a/b/"), true);
    assert.equal(pathStartsWithRoot("/a/bc", "/a/b/"), false);
  });

  test("empty root returns false", () => {
    assert.equal(pathStartsWithRoot("/a/b", ""), false);
  });
});

describe("computeAncestorChain", () => {
  test("cwd equals homeDir returns empty list", () => {
    assert.deepEqual(computeAncestorChain("/h/u", "/h/u"), []);
  });

  test("cwd is direct child of homeDir returns cwd", () => {
    assert.deepEqual(computeAncestorChain("/h/u/p", "/h/u"), ["/h/u/p"]);
  });

  test("multi-level chain excludes homeDir", () => {
    assert.deepEqual(
      computeAncestorChain("/h/u/work/proj", "/h/u"),
      ["/h/u/work/proj", "/h/u/work"],
    );
  });

  test("cwd outside homeDir stops before filesystem root", () => {
    const chain = computeAncestorChain("/tmp/proj", "/h/u");
    assert.deepEqual(chain, ["/tmp/proj", "/tmp"]);
    assert.equal(chain.includes("/"), false);
  });

  test("trailing separators are normalized", () => {
    assert.deepEqual(computeAncestorChain("/h/u/p/", "/h/u/"), ["/h/u/p"]);
  });
});
