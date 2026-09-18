import assert from "node:assert/strict";
import test from "node:test";
import { createDragStuckWatch } from "../src/dragStuckWatch.ts";

test("① 主键按住期间永不判定卡死(正常拖拽,多久都不动作)", () => {
  const w = createDragStuckWatch();
  for (let t = 0; t < 30000; t += 250) {
    assert.equal(w.sample(true, t), "none", `t=${t}`);
  }
});

test("② 主键松开但未满阈值 → 不动作(正常松手到会话结束的窗口)", () => {
  const w = createDragStuckWatch();
  assert.equal(w.sample(true, 0), "none");
  assert.equal(w.sample(false, 250), "none");
  assert.equal(w.sample(false, 750), "none");
  assert.equal(w.sample(false, 999), "none");
});

test("③ 松开持续满阈值 → 注入 Esc 一次,不重复注入", () => {
  const w = createDragStuckWatch();
  w.sample(true, 0);
  assert.equal(w.sample(false, 500), "none");
  assert.equal(w.sample(false, 1500), "cancel");
  assert.equal(w.sample(false, 1750), "none");
  assert.equal(w.sample(false, 2000), "none");
});

test("④ 注入后仍卡死满 1s → 提示一次,且不再重复提示", () => {
  const w = createDragStuckWatch();
  assert.equal(w.sample(false, 0), "none");
  assert.equal(w.sample(false, 1000), "cancel");
  assert.equal(w.sample(false, 1500), "none");
  assert.equal(w.sample(false, 2000), "prompt");
  assert.equal(w.sample(false, 2250), "none");
  assert.equal(w.sample(false, 5000), "none");
});

test("⑤ 中途重新按下(拖拽仍在正常进行)→ 计时清零,不再判定", () => {
  const w = createDragStuckWatch();
  assert.equal(w.sample(false, 0), "none");
  assert.equal(w.sample(false, 800), "none");
  assert.equal(w.sample(true, 900), "none"); // 又按住了
  assert.equal(w.sample(false, 1200), "none"); // 重新计时
  assert.equal(w.sample(false, 1900), "none"); // 距 1200 未满 1s
  assert.equal(w.sample(false, 2200), "cancel"); // 满 1s 才动作
});

test("⑥ reset 后重新计时(下一次拖拽互不影响)", () => {
  const w = createDragStuckWatch();
  assert.equal(w.sample(false, 0), "none");
  assert.equal(w.sample(false, 1000), "cancel");
  w.reset();
  assert.equal(w.sample(false, 1100), "none");
  assert.equal(w.sample(false, 2200), "cancel");
});

test("⑦ 阈值可配(便于按实测调参)", () => {
  const w = createDragStuckWatch(300, 100);
  assert.equal(w.sample(false, 0), "none");
  assert.equal(w.sample(false, 200), "none");
  assert.equal(w.sample(false, 400), "cancel");
  assert.equal(w.sample(false, 550), "prompt");
});
