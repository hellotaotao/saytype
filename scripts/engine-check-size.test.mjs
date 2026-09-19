import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../src/views/settings.css", import.meta.url), "utf8");
test("engine check stays compact inside a box that keeps the title aligned", () => {
  const button = css.match(/\.engine-check \{([^}]+)\}/)[1];
  assert.match(button, /width: 32px/);
  assert.match(button, /height: 32px/);
  const box = css.match(/\.engine-check::before \{([^}]+)\}/)?.[1] || "";
  assert.match(box, /width: 20px/);
  assert.match(box, /height: 20px/);
  assert.match(css, /\.engine-check \.material-icons \{[^}]*font-size: 14px/);
});
