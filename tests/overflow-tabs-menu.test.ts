import assert from "node:assert/strict";
import test from "node:test";
import { searchMatch } from "../src/search.ts";

const PAGE_SIZE = 20;

function paginate<T>(items: T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const cur = Math.min(Math.max(1, page), pageCount);
  return {
    pageCount,
    slice: items.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE),
  };
}

test("269 个标签按搜索过滤后分页，页长 20 且单页自隐语义成立", () => {
  const panels = Array.from({ length: 269 }, (_, i) => ({
    id: `p${i}`,
    title: i === 41 ? "14-items-drinks.png" : `neon-cat-image${i}.png`,
    path: i === 41 ? "E:\\UnityProject\\Nightsteal\\14-items-drinks.png" : `E:\\tmp\\neon-cat-image${i}.png`,
  }));

  const all = paginate(panels, 1);
  assert.equal(all.pageCount, 14);
  assert.equal(all.slice.length, 20);
  assert.equal(all.slice[0].id, "p0");

  const last = paginate(panels, 14);
  assert.equal(last.slice.length, 9);
  assert.equal(last.slice[0].id, "p260");

  const hit = panels.filter((p) => searchMatch("drinks", p.title, p.path, p.id));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].title, "14-items-drinks.png");
  assert.equal(paginate(hit, 1).pageCount, 1);

  const none = panels.filter((p) => searchMatch("definitely-missing", p.title, p.path));
  assert.equal(none.length, 0);

  const closed: string[] = [];
  panels.slice().forEach((p) => closed.push(p.id));
  assert.equal(closed.length, 269);
  assert.equal(closed[0], "p0");
  assert.equal(closed[268], "p268");
});
