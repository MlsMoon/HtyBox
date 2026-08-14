import assert from "node:assert/strict";
import test from "node:test";
import { launchCmdFor } from "../src/profiles.ts";

test("Grok uses official model ids and precise resume commands", () => {
  assert.equal(
    launchCmdFor("grok", false, undefined, "grok-4.6", "先读协作简报"),
    'grok --model grok-4.6 "先读协作简报"\r',
  );
  assert.equal(
    launchCmdFor("grok", true, "12345678-1234-4abc-8def-1234567890ab"),
    "grok --resume 12345678-1234-4abc-8def-1234567890ab\r",
  );
});
