// P2 测试：配置文件优先级 / 剪贴板读写 / 面板脚本
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const cfgs = await import("file:///E:/DSH-X2/src/config.js");
const clip = await import("file:///E:/DSH-X2/src/clipboard.js");

// 1) 配置文件路径（USERPROFILE 已被外层改到 E 盘测试目录）
console.log("1) config file:", cfgs.configPath());

// 2) 写入 + 读取 + 优先级
cfgs.writeFileConfig({ settleMs: 999, hotkeyArm: false });
const fileCfg = cfgs.readFileConfig();
console.log("2) file config:", JSON.stringify(fileCfg));
const merged = cfgs.mergeConfig({ settleMs: 180, overlay: true, hotkeyArm: true });
console.log("   merged (file wins):", JSON.stringify({ settleMs: merged.settleMs, hotkeyArm: merged.hotkeyArm, overlay: merged.overlay }));

// 3) 剪贴板往返（先备份，再恢复）
const before = clip.readClipboard();
const okWrite = clip.writeClipboard("dsh-x2 clipboard test 中文 ✓");
const got = clip.readClipboard();
clip.writeClipboard(before ?? "");
console.log("3) clipboard write:", okWrite, "| read back matches:", got === "dsh-x2 clipboard test 中文 ✓", "| restored:", clip.readClipboard() === (before ?? ""));

// 4) 面板脚本存在且是 ASCII
const ps1 = "E:\\DSH-X2\\tools\\config-x2.ps1";
const bytes = fs.readFileSync(ps1);
const nonAscii = [...bytes].filter((b) => b > 127).length;
console.log("4) config-x2.ps1 bytes:", bytes.length, "| non-ascii bytes:", nonAscii);

// 5) 面板脚本非交互跑一次（输入 0 直接退出），验证能写文件
try {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
    input: "0\n",
    encoding: "utf8",
    timeout: 20000,
  });
  console.log("5) panel ran, output tail:", out.trim().split("\n").slice(-2).join(" | "));
} catch (e) {
  console.log("5) panel failed:", e.message.slice(0, 120));
}
