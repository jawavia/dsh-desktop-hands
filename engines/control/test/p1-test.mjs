// P1 测试：多显示器 / 局部放大 / sequence 失败回滚
import fs from "node:fs";

const registered = [];
const ctx = { logger: { info: () => {}, warn: () => {} }, tools: { register: (t) => { registered.push(t); return () => {}; } }, on: () => {} };
const policyDir = "E:\\DSH-X2\\.p1-policy";
try { fs.rmSync(policyDir, { recursive: true, force: true }); } catch {}

const config = {
  readOnly: false, allowRisky: false, shotDir: "E:\\DSH-X2\\.p1-shots",
  observeMaxWidth: 900, observeMaxHeight: 600, typeDelayMs: 0, requireFreshLookSeconds: 120,
  settleMs: 60, maxSequenceSteps: 24, uiaMinControls: 3, overlay: false, overlayIdleMs: 0,
  cancelOnEsc: false, armRequired: true, armSeconds: 1200, audit: true, policyDir, hotkeyArm: false,
};

const m = await import("file:///E:/DSH-X2/src/index.js");
const pol = await import("file:///E:/DSH-X2/src/policy.js");
const w32 = await import("file:///E:/DSH-X2/src/win32.js");
m.apply(ctx, config);
const look = registered.find((t) => t.name === "screen_look");
const act = registered.find((t) => t.name === "screen_act");
const seq = registered.find((t) => t.name === "screen_sequence");

// 1) 多显示器
const monitors = w32.listMonitors();
console.log("1) monitors:", JSON.stringify(monitors));

// 2) 局部放大
pol.arm(120, "p1", config);
const z = await look.execute({ mode: "pixels", region: { x: 0, y: 1700, width: 200, height: 100 }, zoom: 3, maxWidth: 1600, maxHeight: 1200 });
const zoomLine = (z.summary || "").split("\n").find((l) => l.includes("已放大")) || "(no zoom line)";
console.log("2) zoom image:", z.imageWidth + "x" + z.imageHeight, "| src:", z.sourceWidth + "x" + z.sourceHeight, "|", zoomLine);

// 3) sequence 中途失败 → 回滚
const bad = await seq.execute({
  steps: [
    { action: "click", x: 50, y: 1725 },
    { action: "key", key: "definitely_not_a_key" },
  ],
  capture: "none",
  settleMs: 0,
});
console.log("3) sequence:", String(bad).split("\n").slice(0, 4).join(" | "));
console.log("   audit verify:", JSON.stringify(pol.verifyAudit(config)));

// 4) 单步失败也不卡键（act 的 key 传非法键名）
try {
  await act.execute({ action: "key", key: "also_not_a_key", observe: false });
  console.log("4) act: 没抛错（意外）");
} catch (e) {
  console.log("4) act threw (expected):", e.message.slice(0, 80));
}

pol.disarm(config);
