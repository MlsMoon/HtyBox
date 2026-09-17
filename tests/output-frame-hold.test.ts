import assert from "node:assert/strict";
import test from "node:test";
import { createSyncOutputHold } from "../src/outputFrameHold.ts";

const enc = new TextEncoder();
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const bytes = (s: string) => enc.encode(s);
const join = (chunks: Uint8Array[]) => Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("latin1");
const MAX = 1 << 20;

test("① 单块内完整帧直通,顺序不变", () => {
  const h = createSyncOutputHold(MAX);
  const frame = bytes(`${BSU}line1\r\nline2${ESU}\x1b[1A\x1b[6G`);
  const out = h.push(frame);
  assert.equal(out.length, 1);
  assert.equal(join(out), join([frame]));
  assert.equal(h.holding, false);
});

test("② 帧跨 3 块:前两块暂存,ESU 到齐一并放行", () => {
  const h = createSyncOutputHold(MAX);
  const a = bytes(`${BSU}part-a`);
  const b = bytes("part-b");
  const c = bytes(`part-c${ESU}`);
  assert.deepEqual(h.push(a), []);
  assert.equal(h.holding, true);
  assert.deepEqual(h.push(b), []);
  const out = h.push(c);
  assert.equal(join(out), join([a, b, c]));
  assert.equal(h.holding, false);
});

test("③ BSU 被拆在两块边界仍识别为帧开始", () => {
  const h = createSyncOutputHold(MAX);
  const head = bytes("tail-of-prev\x1b[?20"); // 前缀前半
  const rest = bytes(`26hframe-body`); // 前缀后半 + h
  const out1 = h.push(head);
  assert.equal(join(out1), join([head])); // 前缀前半随块直通(解析器跨 write 拼接)
  assert.deepEqual(h.push(rest), []);
  assert.equal(h.holding, true);
  const out2 = h.push(bytes(`end${ESU}`));
  assert.equal(join(out2), `26hframe-bodyend${ESU}`);
});

test("④ ESU 被拆在两块边界仍识别为帧结束", () => {
  const h = createSyncOutputHold(MAX);
  assert.deepEqual(h.push(bytes(`${BSU}body\x1b[?2`)), []);
  assert.equal(h.holding, true);
  const out = h.push(bytes("026lafter"));
  assert.equal(join(out), `${BSU}body\x1b[?2026lafter`);
  assert.equal(h.holding, false);
});

test("⑤ 无 2026 的普通流零暂存,块原样直通", () => {
  const h = createSyncOutputHold(MAX);
  for (const s of ["plain\r\n", "\x1b[2K\x1b[?25l", "\x1b[?2004h", "\x1b[?2026$p"]) {
    const c = bytes(s);
    const out = h.push(c);
    assert.equal(out.length, 1);
    assert.equal(out[0], c);
    assert.equal(h.holding, false);
  }
});

test("⑥ 暂存达到上限即自动放行并退出暂存态", () => {
  const h = createSyncOutputHold(16);
  const a = bytes(`${BSU}0123`); // 12 字节
  const b = bytes("456789"); // 累计 18 ≥ 16
  assert.deepEqual(h.push(a), []);
  const out = h.push(b);
  assert.equal(join(out), join([a, b]));
  assert.equal(h.holding, false);
  // 上限后的后继块直通,直到迟到的 ESU(无重复放行)
  const c = bytes(`tail${ESU}`);
  const out2 = h.push(c);
  assert.equal(join(out2), join([c]));
  assert.equal(h.holding, false);
});

test("⑦ flush 强制放行后,迟到的 ESU 不重复放行、不丢字节", () => {
  const h = createSyncOutputHold(MAX);
  const a = bytes(`${BSU}slow-frame`);
  assert.deepEqual(h.push(a), []);
  const flushed = h.flush();
  assert.equal(join(flushed), join([a]));
  assert.equal(h.holding, false);
  assert.deepEqual(h.flush(), []);
  const b = bytes(`rest${ESU}`);
  assert.equal(join(h.push(b)), join([b]));
  // 下一帧重新进入暂存
  assert.deepEqual(h.push(bytes(`${BSU}next`)), []);
  assert.equal(h.holding, true);
});

test("⑧ 随机切块:输出拼接 === 输入(不丢、不乱序、不改写)", () => {
  const stream = bytes(
    `boot\r\n${BSU}f1-a\r\nf1-b${ESU}\x1b[3A\x1b[8G\x1b[?25l${BSU}${"x".repeat(300)}${ESU}mid${BSU}f3${ESU}tail`,
  );
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 50; round++) {
    const h = createSyncOutputHold(MAX);
    const out: Uint8Array[] = [];
    let i = 0;
    while (i < stream.length) {
      const n = 1 + Math.floor(rnd() * 12);
      out.push(...h.push(stream.subarray(i, i + n)));
      i += n;
    }
    out.push(...h.flush());
    assert.equal(join(out), join([stream]), `round ${round}`);
  }
});

test("⑨ 同块含前帧闭合 + 后帧开启:前段即时放行,仅从 BSU 起暂存", () => {
  const h = createSyncOutputHold(MAX);
  assert.deepEqual(h.push(bytes(`${BSU}frame-N`)), []);
  const mixed = bytes(`-end${ESU}\x1b[2G${BSU}frame-N+1`);
  const out = h.push(mixed);
  assert.equal(join(out), `${BSU}frame-N-end${ESU}\x1b[2G`);
  assert.equal(h.holding, true);
  const out2 = h.push(bytes(`!${ESU}`));
  assert.equal(join(out2), `${BSU}frame-N+1!${ESU}`);
});
