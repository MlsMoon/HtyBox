import assert from "node:assert/strict";
import test from "node:test";

import { terminalTextInputData } from "../src/platformServices/keyboardCore.ts";

test("macOS handles a committed ASCII question mark once", () => {
  assert.equal(
    terminalTextInputData("macos", {
      inputType: "insertText",
      data: "?",
      isComposing: false,
    }),
    "?",
  );
});

test("Windows and Unix keep xterm's native input path", () => {
  const event = { inputType: "insertText", data: "?", isComposing: false };
  assert.equal(terminalTextInputData("windows", event), undefined);
  assert.equal(terminalTextInputData("unix", event), undefined);
});

test("composition and unrelated text remain untouched", () => {
  assert.equal(
    terminalTextInputData("macos", {
      inputType: "insertText",
      data: "?",
      isComposing: true,
    }),
    undefined,
  );
  assert.equal(
    terminalTextInputData("macos", {
      inputType: "insertCompositionText",
      data: "?",
      isComposing: false,
    }),
    undefined,
  );
  assert.equal(
    terminalTextInputData("macos", {
      inputType: "insertText",
      data: "？",
      isComposing: false,
    }),
    undefined,
  );
  assert.equal(
    terminalTextInputData("macos", {
      inputType: "insertText",
      data: "/",
      isComposing: false,
    }),
    undefined,
  );
});
