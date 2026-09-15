import assert from "node:assert/strict";
import test from "node:test";
import { filePathKey } from "../src/filePathKey.ts";

test("filePathKey matches slash, case, and Windows extended prefix", () => {
  assert.equal(filePathKey(String.raw`G:\a\b.SVG`), "g:/a/b.svg");
  assert.equal(filePathKey("g:/a/b.svg"), "g:/a/b.svg");
  assert.equal(filePathKey(String.raw`\\?\G:\a\b.svg`), "g:/a/b.svg");
  assert.equal(filePathKey("//?/G:/a/b.svg"), "g:/a/b.svg");
});

test("filePathKey distinguishes sibling files", () => {
  assert.notEqual(filePathKey(String.raw`G:\a\b.svg`), filePathKey(String.raw`G:\a\c.svg`));
});
