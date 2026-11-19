// 真机端到端：用修好的代码往记事本打 462 字，看读回校验是否通过。
// 前置：先按 Ctrl+Alt+F9 开人类授权窗口（脚本用真实策略目录，不关闸门、不 mock）。
// 注意：这是真注入按键，跑之前确认记事本在前台、里面是要覆盖的测试文本。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createTools } = await import("file:///E:/DSH-X2/src/tools.js");

const registered = [];
const ctx = {
  logger: { info: (...a) => console.log("[info]", ...a), warn: (...a) => console.log("[warn]", ...a) },
  tools: { register: (t) => { registered.push(t); return () => {}; } },
  on: () => {},
};

const config = {
  readOnly: false, allowRisky: false,
  shotDir: path.join(os.tmpdir(), "dsh-x2", "shots"),
  observeMaxWidth: 900, observeMaxHeight: 700, typeDelayMs: 0,
  requireFreshLookSeconds: 120, settleMs: 120, maxSequenceSteps: 24, uiaMinControls: 3,
  overlay: false, overlayIdleMs: 0, overlayWarm: false, cancelOnEsc: true,
  armRequired: true, armSeconds: 1200, audit: true, hotkeyArm: false,
  typeChunkChars: 240, typeChunkDelayMs: 25, typeVerifyMinChars: 400, typePasteThreshold: 2000,
  imageBudget: 0,
};

const tools = createTools(ctx, config);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
console.log("tools:", tools.map((t) => t.name).join(", "));

const armFile = path.join(os.tmpdir(), "dsh-x2", "arm.json");
const arm = JSON.parse(fs.readFileSync(armFile, "utf8"));
console.log("arm.json:", JSON.stringify(arm), "| armed:", arm.armedUntil > Date.now());

await byName.screen_look.execute({ mode: "pixels", region: { x: 380, y: 252, width: 300, height: 200 }, maxWidth: 300, maxHeight: 200 });
await byName.screen_focus.execute({ window: "Notepad" });
const sel = await byName.screen_act.execute({ action: "hotkey", keys: "ctrl+a", observe: false });
console.log("select-all:", sel.split("\n")[0]);

const text = "dsh-x2 长文本校验 0123456789 abcdefghij 中文读回测试 ".repeat(11);
console.log("text length:", text.length, "| clipboard before:", JSON.stringify((await import("file:///E:/DSH-X2/src/clipboard.js")).readClipboard()));

const t0 = Date.now();
const out = await byName.screen_act.execute({ action: "type", text, verifyText: true, observe: false, window: "Notepad" });
console.log("elapsed ms:", Date.now() - t0);
console.log(out);

const pass = /校验通过/.test(out) && /读回 461 字|读回 462 字/.test(out);
console.log("RESULT:", pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
