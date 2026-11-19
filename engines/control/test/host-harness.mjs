// 假 host 测试：验证 dsh-x2 的 apply() 真注册 6 个工具，且授权闸门真的拦
import fs from "node:fs";

const logs = [];
const registered = [];
const ctx = {
  logger: { info: (...a) => logs.push(["info", a.join(" ")]), warn: (...a) => logs.push(["warn", a.join(" ")]) },
  tools: { register: (tool) => { registered.push(tool); return () => {}; } },
  on: () => {},
};

const policyDir = "E:\\DSH-X2\\.test-policy";
try { fs.rmSync(policyDir, { recursive: true, force: true }); } catch {}

const config = {
  readOnly: false, allowRisky: false, shotDir: "E:\\DSH-X2\\.test-shots",
  observeMaxWidth: 1280, observeMaxHeight: 900, typeDelayMs: 0, requireFreshLookSeconds: 0,
  settleMs: 0, maxSequenceSteps: 24, uiaMinControls: 3, overlay: false, overlayIdleMs: 0,
  cancelOnEsc: true, armRequired: true, armSeconds: 1200, audit: true, policyDir,
};

const m = await import("file:///E:/DSH-X2/src/index.js");
console.log("name:", m.name, "| inject:", JSON.stringify(m.inject));
try {
  m.apply(ctx, config);
} catch (e) {
  console.log("APPLY THREW:", e.message);
}
console.log("registered tools:", registered.length, "->", registered.map((t) => t.name).join(", "));
console.log("logs:", logs.map(([lvl, s]) => `${lvl}:${s.slice(0, 80)}`).join(" | "));

// 闸门测试：未授权时点击必须被拒
const act = registered.find((t) => t.name === "screen_act");
if (act) {
  try {
    const r = await act.execute({ action: "click", x: 100, y: 100 });
    console.log("unarmed click result:", String(r).slice(0, 120).replace(/\n/g, " "));
  } catch (e) {
    console.log("unarmed click threw:", e.message);
  }
} else {
  console.log("screen_act NOT FOUND");
}

// 审计文件是否生成
const auditFile = "E:\\DSH-X2\\.test-policy\\audit.jsonl";
console.log("audit exists:", fs.existsSync(auditFile), fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean).length + " lines" : "");
