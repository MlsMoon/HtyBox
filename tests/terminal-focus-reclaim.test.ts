import assert from "node:assert/strict";
import test from "node:test";
import { shouldReclaimFocus, type ElLike } from "../src/focusReclaim.ts";

/** 桩元素:closest 按三类选择器分别命中(硬控件/弹层/标签/tabindex 容器)。 */
function el(opts: {
  connected?: boolean;
  hardControl?: boolean;   // input/textarea/button/select/a/[contenteditable]
  focusable?: boolean;     // 仅 [tabindex](如 dv-tab div 自身)
  overlay?: boolean;
  tab?: boolean;
}): ElLike {
  const { connected = true, hardControl = false, focusable = false, overlay = false, tab = false } = opts;
  return {
    isConnected: connected,
    closest(sel: string) {
      if (sel === "[data-hty-overlay]") return overlay ? this : null;
      if (sel === ".dv-tab") return tab ? this : null;
      if (sel === "[tabindex]") return focusable || tab ? this : null;
      // HARD_CONTROL_SELECTOR
      if (hardControl) return this;
      return null;
    },
  };
}

const base = {
  targetWasInScope: true,
  focusIsBody: true,
  tabSelectable: false,
};

test("dock 内非控件 + 焦点流落 → 归位(点已激活标签/死区场景)", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({}) }), true);
});

test("焦点未流落(如 xterm 自己已聚焦/输入框) → 不归位", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({}), focusIsBody: false }), false);
});

test("tabSelectable=开 → 不归位(键盘归 UI 语义)", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({}), tabSelectable: true }), false);
});

test("目标是硬控件(按钮/输入/链接) → 不归位", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({ hardControl: true }) }), false);
});

test("目标是标签内的硬控件(重命名输入框) → 不归位(反抢焦点关键豁免)", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({ hardControl: true, tab: true }) }), false);
});

test("目标是 dockview 标签本体(div tabindex=0) → 归位(标签不吃焦点的锁定偏好)", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({ focusable: true, tab: true }) }), true);
});

test("目标是带 tabindex 的 dockview chrome 容器(分组/标签栏空白) → 归位(非输入目标)", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({ focusable: true }) }), true);
});

test("目标在 dock 容器外(侧栏等) → 不归位(决策 2A)", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: el({}), targetWasInScope: false }), false);
});

test("无目标 → 不归位", () => {
  assert.equal(shouldReclaimFocus({ ...base, target: null }), false);
});

test("目标已卸载且属弹层(遮罩外点/弹层按钮关闭) → 归位", () => {
  assert.equal(
    shouldReclaimFocus({ ...base, target: el({ connected: false, overlay: true }), targetWasInScope: false }),
    true,
  );
});

test("目标已卸载但不属弹层(侧栏里随操作消失的控件) → 不归位", () => {
  assert.equal(
    shouldReclaimFocus({ ...base, target: el({ connected: false }), targetWasInScope: false }),
    false,
  );
});

test("目标已卸载且属弹层,但焦点未流落(弹层后继输入框已聚焦,如重命名) → 不归位", () => {
  assert.equal(
    shouldReclaimFocus({
      ...base,
      target: el({ connected: false, overlay: true }),
      targetWasInScope: false,
      focusIsBody: false,
    }),
    false,
  );
});
