// 配置热更新测试：apply 之后改配置文件，下一次调用应生效
import fs from "node:fs";

process.env.USERPROFILE = "E:\\DSH-X2\\.hot-home";
fs.rmSync(process.env.USERPROFILE, { recursive: true, force: true });
fs.mkdirSync(process.env.USERPROFILE, { recursive: true });

const cfgs = await import("file:///E:/DSH-X2/src/config.js");
cfgs.writeFileConfig({ imageBudget: 2 });

const registered = [];
const ctx = { logger: { info: () => {}, warn: () => {} }, tools: { register: (t) => { registered.push(t); return () => {}; } }, on: () => {} };
const config = {
  readOnly: false, allowRisky: false, shotDir: "E:\\DSH-X2\\.hot-shots",
  observeMaxWidth: 700, observeMaxHeight: 400, typeDelayMs: 0, requireFreshLookSeconds: 120,
  settleMs: 60, maxSequenceSteps: 24, uiaMinControls: 3, overlay: false, overlayIdleMs: 0,
  cancelOnEsc: false, armRequired: true, armSeconds: 1200, audit: true, policyDir: "E:\\DSH-X2\\.hot-policy", hotkeyArm: false,
};
const m = await import("file:///E:/DSH-X2/src/index.js");
m.apply(ctx, config);
const look = registered.find((t) => t.name === "screen_look");

const r1 = await look.execute({ mode: "pixels", region: { x: 0, y: 1680, width: 200, height: 100 }, maxWidth: 400, maxHeight: 200 });
console.log("1) before change:", (r1.summary || "").split("\n").find((l) => l.includes("软预算")) || "(no budget line)");

cfgs.writeFileConfig({ imageBudget: 5 });
await new Promise((r) => setTimeout(r, 400));

const r2 = await look.execute({ mode: "pixels", region: { x: 0, y: 1680, width: 200, height: 100 }, maxWidth: 400, maxHeight: 200 });
console.log("2) after change :", (r2.summary || "").split("\n").find((l) => l.includes("软预算")) || "(no budget line)");
console.log("3) hot reload works:", /软预算\s*5/.test(r2.summary || ""));

fs.rmSync(process.env.USERPROFILE, { recursive: true, force: true });
