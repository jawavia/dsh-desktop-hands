import fs from "node:fs";
import { startHotkeys } from "file:///E:/DSH-X2/src/hotkey.js";
import { readState } from "file:///E:/DSH-X2/src/policy.js";
import { hotkey } from "file:///E:/DSH-X2/src/win32.js";

const cfg = { policyDir: "E:\\DSH-X2\\.hk-policy", armSeconds: 60 };
try { fs.rmSync(cfg.policyDir, { recursive: true, force: true }) } catch {}
const stop = startHotkeys({ config: cfg, onArm: (s) => console.log("onArm", s), onDisarm: () => console.log("onDisarm") });
await new Promise((r) => setTimeout(r, 300));
console.log("before:", JSON.stringify(readState(cfg)));
hotkey(["ctrl", "alt", "f9"]);
await new Promise((r) => setTimeout(r, 600));
const st = readState(cfg);
console.log("after F9:", JSON.stringify(st), "| armed in future:", st.armedUntil > Date.now());
hotkey(["ctrl", "alt", "f10"]);
await new Promise((r) => setTimeout(r, 600));
const st2 = readState(cfg);
console.log("after F10:", JSON.stringify(st2), "| disarmed:", !(st2.armedUntil > Date.now()));
stop();
