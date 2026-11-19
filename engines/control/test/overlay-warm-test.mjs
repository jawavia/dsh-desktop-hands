// overlay 预热开关对比：起进程后看 overlay 是否被拉起
import { execFileSync } from "node:child_process";

const mode = process.env.WARM === "1";
const script = `
Promise.all([import('file:///E:/DSH-X2/src/index.js'), import('file:///E:/DSH-X2/src/overlay.js')]).then(([m, o]) => {
  const reg = [];
  m.apply({ logger: { info: () => {}, warn: () => {} }, tools: { register: (t) => { reg.push(t); return () => {} } }, on: () => {} }, {
    readOnly: false, allowRisky: false, shotDir: 'E:\\\\DSH-X2\\\\.ow', observeMaxWidth: 800, observeMaxHeight: 600,
    typeDelayMs: 0, requireFreshLookSeconds: 120, settleMs: 0, maxSequenceSteps: 24, uiaMinControls: 3,
    overlay: true, overlayIdleMs: 0, overlayWarm: ${mode}, cancelOnEsc: false, armRequired: true,
    armSeconds: 1200, audit: true, policyDir: 'E:\\\\DSH-X2\\\\.owp', hotkeyArm: false,
  });
  const st = o.overlayStatus();
  console.log('warm=' + ${mode} + ' overlay running=' + st.running);
  setTimeout(() => process.exit(0), 400);
});
`;
const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000 });
console.log(out.trim());
