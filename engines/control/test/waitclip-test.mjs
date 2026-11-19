// waitClipboardChange 自测：模拟"复制迟到"的剪贴板。
// 背景：2026-11-04 真机验收发现，长文本 462 字实际打全，读回校验却报"读回 42 字"——
// 读回的正是校验前剪贴板里的 42 字标记。固定 sleep(250ms) 挡不住目标程序异步处理按键。
import { execFileSync, spawn } from "node:child_process";
import { readClipboard, waitClipboardChange } from "file:///E:/DSH-X2/src/clipboard.js";

function setClipboard(v) {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${v}'`], { windowsHide: true });
}

// 0) 记住用户原剪贴板，测试后还原
setClipboard("A-OLD");
console.log("0) clipboard set to:", JSON.stringify(readClipboard()));

// 1) 模拟"迟到的复制"：700ms 之后剪贴板才变成 B-NEW
const child = spawn(process.execPath, ["-e",
  "setTimeout(()=>{require('child_process').execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',\"Set-Clipboard -Value 'B-NEW'\"],{windowsHide:true})},700)",
], { detached: true, stdio: "ignore", windowsHide: true });
child.unref();

const t0 = Date.now();
const got = waitClipboardChange("A-OLD", { timeoutMs: 3000 });
const elapsed = Date.now() - t0;
console.log("1) waitClipboardChange ->", JSON.stringify(got), "| elapsed", elapsed + "ms", "| waited for late copy:", got === "B-NEW");

// 2) 内容不变时应超时返回原值（不能无限等）
const t1 = Date.now();
const got2 = waitClipboardChange("B-NEW", { timeoutMs: 700 });
const elapsed2 = Date.now() - t1;
console.log("2) no-change case ->", JSON.stringify(got2), "| elapsed", elapsed2 + "ms", "| bounded:", elapsed2 < 3000);

const pass = got === "B-NEW" && got2 === "B-NEW" && elapsed >= 600;
console.log("RESULT:", pass ? "PASS" : "FAIL");
setClipboard("A-OLD");
process.exit(pass ? 0 : 1);
