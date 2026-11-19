// 真实截图 + 晶格测试（只截图，不点击）
import fs from "node:fs";

const registered = [];
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (t) => { registered.push(t); return () => {}; } },
  on: () => {},
};
const policyDir = "E:\\DSH-X2\\.test-policy2";
try { fs.rmSync(policyDir, { recursive: true, force: true }); } catch {}

const config = {
  readOnly: false, allowRisky: false, shotDir: "E:\\DSH-X2\\.test-shots2",
  observeMaxWidth: 1280, observeMaxHeight: 900, typeDelayMs: 0, requireFreshLookSeconds: 0,
  settleMs: 0, maxSequenceSteps: 24, uiaMinControls: 3, overlay: false, overlayIdleMs: 0,
  cancelOnEsc: true, armRequired: true, armSeconds: 1200, audit: true, policyDir,
};

const m = await import("file:///E:/DSH-X2/src/index.js");
m.apply(ctx, config);
const look = registered.find((t) => t.name === "screen_look");
const r = await look.execute({ mode: "grid", gridCols: 6, gridRows: 4 });
console.log("mode:", r.mode, "| path:", r.path);
console.log("image:", r.imageWidth + "x" + r.imageHeight, "| source:", r.sourceWidth + "x" + r.sourceHeight);
console.log("origin:", r.originX + "," + r.originY, "| scale:", r.scaleX.toFixed(2), r.scaleY.toFixed(2));
console.log("summary head:\n" + (r.summary || "").split("\n").slice(0, 5).join("\n"));
