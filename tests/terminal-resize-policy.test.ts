import assert from "node:assert/strict";
import test from "node:test";
import { shouldPullScrollbackOnGrow } from "../src/terminalResizePolicy.ts";

const cur = { cols: 145, rows: 48 };

test("① 仅行数变多(列数不变)→ 走拉回历史", () => {
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 145, rows: 49 }), true);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 145, rows: 96 }), true);
});

test("② 行数变少 / 不变 → 默认路径(裁掉光标下方空行本就正确)", () => {
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 145, rows: 28 }), false);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 145, rows: 48 }), false);
});

test("③ 列数变化一律走默认路径(避免与 ConPTY 双重 reflow 引发叠影)", () => {
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 200, rows: 96 }), false);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 100, rows: 96 }), false);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 200, rows: 48 }), false);
});

test("④ 尺寸不可用(undefined / NaN)→ 默认路径", () => {
  assert.equal(shouldPullScrollbackOnGrow(cur, undefined), false);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: NaN, rows: 96 }), false);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 145, rows: NaN }), false);
  assert.equal(shouldPullScrollbackOnGrow(cur, { cols: 145, rows: Infinity }), false);
});
