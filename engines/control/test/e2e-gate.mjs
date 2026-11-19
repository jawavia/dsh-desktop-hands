// 端到端：闸门拒 → arm → 真实点击（任务栏空白）→ 审计链校验
import fs from "node:fs";
import os from "node:os";

const registered = [];
const ctx = { logger: { info: () => {}, warn: () => {} }, tools: { register: (t) => { registered.push(t); return () => {}; } }, on: () => {} };
const policyDir = "E:\\DSH-X2\\.e2e-policy";
try { fs.rmSync(policyDir, { recursive: true, force: true }); } catch {}

const config = {
  readOnly: false, allowRisky: false, shotDir: "E:\\DSH-X2\\.e2e-shots",
  observeMaxWidth: 800, observeMaxHeight: 600, typeDelayMs: 0, requireFreshLookSeconds: 0,
  settleMs: 120, maxSequenceSteps: 24, uiaMinControls: 3, overlay: false, overlayIdleMs: 0,
  cancelOnEsc: true, armRequired: true, armSeconds: 1200, audit: true, policyDir,
};

const m = await import("file:///E:/DSH-X2/src/index.js");
const pol = await import("file:///E:/DSH-X2/src/policy.js");
m.apply(ctx, config);
const act = registered.find((t) => t.name === "screen_act");
const look = registered.find((t) => t.name === "screen_look");

// 1) 未授权 → 应被拒
const denied = await act.execute({ action: "click", x: 1900, y: 1740, observe: false });
console.log("1) unarmed:", String(denied).slice(0, 90).replace(/\n/g, " "));

// 2) 授权 3 分钟
pol.arm(180, "e2e", config);
console.log("2) armed:", JSON.stringify(pol.readState(config)).slice(0, 90));

// 3) 先看一眼（合理流程），再点任务栏空白
const shot = await look.execute({ region: { x: 0, y: 1680, width: 2880, height: 120 }, mode: "pixels", maxWidth: 800 });
console.log("3) look:", shot.mode, shot.path ? "shot ok" : "no shot");
const clicked = await act.execute({ action: "click", x: 1900, y: 1740, observe: false });
console.log("4) armed click:", String(clicked).slice(0, 140).replace(/\n/g, " "));

// 4) 审计链
const auditFile = policyDir + "\\audit.jsonl";
const lines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean) : [];
console.log("5) audit lines:", lines.length, "| verify:", JSON.stringify(pol.verifyAudit(config)));

// 5) 收尾：disarm
pol.disarm(config);
console.log("6) disarmed:", pol.check("click", {}, config).slice(0, 60));
