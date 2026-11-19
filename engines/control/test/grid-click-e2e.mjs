// 晶格点击端到端：region 晶格 → 用 grid 编号点任务栏空白格
import fs from "node:fs";

const registered = [];
const ctx = { logger: { info: () => {}, warn: () => {} }, tools: { register: (t) => { registered.push(t); return () => {}; } }, on: () => {} };
const policyDir = "E:\\DSH-X2\\.grid-e2e";
try { fs.rmSync(policyDir, { recursive: true, force: true }); } catch {}

const config = {
  readOnly: false, allowRisky: false, shotDir: "E:\\DSH-X2\\.grid-shots",
  observeMaxWidth: 900, observeMaxHeight: 300, typeDelayMs: 0, requireFreshLookSeconds: 120,
  settleMs: 80, maxSequenceSteps: 24, uiaMinControls: 3, overlay: false, overlayIdleMs: 0,
  cancelOnEsc: true, armRequired: true, armSeconds: 1200, audit: true, policyDir, hotkeyArm: false,
};

const m = await import("file:///E:/DSH-X2/src/index.js");
const pol = await import("file:///E:/DSH-X2/src/policy.js");
m.apply(ctx, config);
const look = registered.find((t) => t.name === "screen_look");
const act = registered.find((t) => t.name === "screen_act");

pol.arm(120, "grid-e2e", config);

const g = await look.execute({ mode: "grid", region: { x: 0, y: 1680, width: 2880, height: 120 }, gridCols: 4, gridRows: 1, maxWidth: 900, maxHeight: 160 });
const gridLines = (g.summary || "").split("\n").filter((l) => l.includes("晶格") || /^A1:/.test(l));
console.log("grid summary:", gridLines.join(" ").slice(0, 200));

const r = await act.execute({ action: "click", grid: "B1", observe: false });
console.log("grid click:", String(r).slice(0, 120).replace(/\n/g, " "));

const auditFile = policyDir + "\\audit.jsonl";
const rows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean) : [];
const allowRow = rows.map((l) => JSON.parse(l)).find((x) => { try { return JSON.parse(x.b).kind === "allow"; } catch { return false; } });
console.log("audit lines:", rows.length, "| verify:", JSON.stringify(pol.verifyAudit(config)));
console.log("allow entry:", allowRow ? allowRow.b : "(none)");

pol.disarm(config);
