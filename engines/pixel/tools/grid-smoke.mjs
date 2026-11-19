// 纯 Node 单元测试（不碰真实桌面 / helper）：多显示器 + 混合 DPI 专项。
// 用模拟的 helper monitors 模型钉住：
//   - 单屏 2880x1800@2x（现状回归）
//   - 主屏 2560x1440@1.5 + 副屏 1920x1080@1 位于 (-1920,0)（左屏负原点）
//   - 显示器选择、fx/fy 映射、lattice 间距（DIP*scale）逐点断言
//   - 混合 DPI 下 coarse/standard/fine/micro 的物理间距四舍五入
//   - 边界点：副屏右边界 x=-1、主屏左边界 x=0、跨屏负坐标、0 尺寸/非法 monitors
// 运行: node tools/grid-smoke.mjs   （全 PASS 退出码 0；断言失败抛错退出码 1）
import assert from 'node:assert/strict'
import {
  dpiAt,
  binningScale,
  captureOutputSize,
  cellCenter,
  cellOfPoint,
  clampPointToVirtual,
  clampRect,
  imageToScreen,
  latticeDip,
  latticeSpacingScreen,
  monitorAt,
  normToScreen,
  normalizeMonitors,
  pointInVirtual,
  screenScaleAt,
  screenToImage,
  screenToNorm,
  snapToLattice,
  validateLatticeInImage,
  virtualScreen,
  zoomSourceRect,
} from '../lib/grid.js'

let checks = 0
function ok(cond, msg) {
  checks += 1
  assert.ok(cond, msg)
}
function eq(actual, expected, msg) {
  checks += 1
  assert.deepEqual(actual, expected, msg)
}
function close(actual, expected, eps, msg) {
  checks += 1
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: expected ~${expected}, got ${actual}`)
}
function pass(name) {
  console.log('PASS ' + name)
}

// 单屏 2880x1800@2x（当前唯一真机验证过的配置）
const SINGLE_2X = [
  { id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 },
]

// 主屏在右（2560x1440@1.5，原点 0,0），副屏在左（1920x1080@1，原点 -1920,0）
const MIXED_RAW = [
  { id: 2, device: '\\\\.\\DISPLAY2', primary: false, x: -1920, y: 0, w: 1920, h: 1080, scale: 1 },
  { id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2560, h: 1440, scale: 1.5 },
]

// ---------------------------------------------------------------------------
// A. 单屏 2880x1800@2x 回归
// ---------------------------------------------------------------------------
{
  const nm = normalizeMonitors(SINGLE_2X)
  eq(nm.length, 1, '单屏模型保留 1 台显示器')
  eq(
    nm[0],
    { id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2880, h: 1800, scale: 2 },
    '单屏字段原样归一化（含 scale=2）',
  )
  eq(virtualScreen(nm), { x: 0, y: 0, w: 2880, h: 1800 }, '单屏虚拟屏 = 显示器矩形')
  eq(monitorAt(nm, 1440, 900), nm[0], '屏幕中心命中唯一显示器')
  eq(screenScaleAt(nm, 1440, 900), 2, '单屏任意点 scale=2')
  eq(dpiAt(nm, 1440, 900), 192, 'scale 2 → 192 DPI')
  // DIP 间距 → 物理 px
  eq(latticeSpacingScreen('coarse', 2), 360, 'coarse 180 DIP @2x = 360px')
  eq(latticeSpacingScreen('standard', 2), 180, 'standard 90 DIP @2x = 180px')
  eq(latticeSpacingScreen('fine', 2), 90, 'fine 45 DIP @2x = 90px')
  eq(latticeSpacingScreen('micro', 2), 45, 'micro 22.5 DIP @2x = 45px')
  // fx/fy 映射（单屏区域）
  const region = { x: 0, y: 0, w: 2880, h: 1800 }
  eq(normToScreen(0, 0, region), { x: 0, y: 0 }, 'fx=fy=0 → 左上角')
  eq(normToScreen(0.5, 0.5, region), { x: 1440, y: 900 }, 'fx=fy=0.5 → 屏幕中心')
  eq(normToScreen(1, 1, region), { x: 2879, y: 1799 }, 'fx=fy=1 → 右下角（区域-1，不越界）')
  eq(screenToNorm(1440, 900, region), { fx: 0.5, fy: 0.5 }, '屏幕中心 → fx=fy=0.5')
  // 晶格吸附（单屏，原点 0）
  const snap = snapToLattice(1440, 900, { originX: 0, originY: 0, spacing: 180 })
  eq({ x: snap.x, y: snap.y }, { x: 1440, y: 900 }, '标准晶格点吸附不动')
  ok(snap.onLattice === true, '已在晶格点上')
  // 截图映射（1600x1000 输出）
  const capture = { source: { x: 0, y: 0, w: 2880, h: 1800 }, width: 1600, height: 1000 }
  eq(imageToScreen(800, 500, capture), { x: 1440, y: 900 }, '图像中心 → 屏幕中心')
  eq(screenToImage(1440, 900, capture), { ix: 800, iy: 500 }, '屏幕中心 → 图像中心')
  pass('A 单屏 2880x1800@2x 回归（虚拟屏/选择/映射/间距/吸附/截图映射）')
}

// ---------------------------------------------------------------------------
// B. 混合 DPI 双屏（副屏在左，负原点）
// ---------------------------------------------------------------------------
{
  const nm = normalizeMonitors(MIXED_RAW)
  eq(nm.length, 2, '双屏模型保留 2 台显示器')
  ok(nm[0].x === -1920 && nm[1].x === 0, '保留显示器 x 偏移（左屏 -1920）')
  eq(nm[0].scale, 1, '副屏 scale=1')
  eq(nm[1].scale, 1.5, '主屏 scale=1.5')
  ok(nm[1].primary === true && nm[0].primary === false, '只标记主屏 primary')
  const virtual = virtualScreen(nm)
  eq(virtual, { x: -1920, y: 0, w: 4480, h: 1440 }, '虚拟屏覆盖负原点副屏：x=-1920 w=4480 h=1440')

  // --- 显示器选择（含边界点）---
  const cases = [
    [0, 0, 1, '主屏左边界 x=0 属主屏'],
    [2559, 1439, 1, '主屏右下角（不越界）'],
    [-1920, 0, 2, '副屏左边界 x=-1920'],
    [-1920, 1079, 2, '副屏左下角'],
    [-1, 1079, 2, '副屏右边界 x=-1 属副屏'],
    [-1, 0, 2, '跨屏交界：x=-1 → 副屏'],
    [1280, 720, 1, '主屏中心'],
    [-960, 540, 2, '副屏中心'],
    [0, 1079, 1, '主屏 x=0 且 y 超出副屏高度 → 主屏'],
    [-1, 1439, 1, 'x 属副屏列但 y 远高于副屏 → 最近是主屏（距离 1px）'],
  ]
  for (const [x, y, wantId, msg] of cases) {
    const m = monitorAt(nm, x, y)
    ok(m !== null && m.id === wantId, `显示器选择: (${x},${y}) → #${wantId}（${msg}）`)
  }
  // 虚拟屏外 → 最近显示器
  ok(monitorAt(nm, 2560, 0).id === 1, '主屏右外侧 x=2560 → 最近主屏')
  ok(monitorAt(nm, -1921, 500).id === 2, '副屏左外侧 x=-1921 → 最近副屏')
  ok(monitorAt(nm, -3000, 500).id === 2, '远左侧 → 最近副屏')
  ok(monitorAt(nm, 5000, 500).id === 1, '远右侧 → 最近主屏')
  ok(monitorAt(nm, 100, 2000).id === 1, '下方 → 最近主屏')
  ok(monitorAt(nm, 100, -100).id === 1, '上方 → 最近主屏')

  // --- per-point DPI ---
  eq(screenScaleAt(nm, -1, 500), 1, '副屏内 scale=1')
  eq(screenScaleAt(nm, -1920, 0), 1, '副屏原点 scale=1')
  eq(screenScaleAt(nm, 0, 0), 1.5, '主屏左边界 scale=1.5')
  eq(screenScaleAt(nm, 1280, 720), 1.5, '主屏中心 scale=1.5')
  eq(screenScaleAt(nm, 2559, 1439), 1.5, '主屏右下角 scale=1.5')
  eq(screenScaleAt(nm, -1921, 0), 1, '副屏左外侧 → 最近副屏 scale=1')
  eq(screenScaleAt(nm, 3000, 0), 1.5, '主屏右外侧 → 最近主屏 scale=1.5')
  eq(dpiAt(nm, -960, 540), 96, '副屏 96 DPI')
  eq(dpiAt(nm, 1280, 720), 144, '主屏 144 DPI')

  // --- fx/fy 映射（虚拟屏负原点）---
  eq(normToScreen(0, 0, virtual), { x: -1920, y: 0 }, '虚拟屏 fx=fy=0 → (-1920,0)')
  eq(normToScreen(0.25, 0.25, virtual), { x: -800, y: 360 }, '虚拟屏 fx=fy=0.25 → (-800,360)')
  eq(normToScreen(0.5, 0.5, virtual), { x: 320, y: 720 }, '虚拟屏中心 → (320,720)')
  eq(normToScreen(1, 1, virtual), { x: 2559, y: 1439 }, '虚拟屏 fx=fy=1 → 右下角')
  eq(screenToNorm(-1920, 0, virtual), { fx: 0, fy: 0 }, '(-1920,0) → fx=fy=0')
  const mid = screenToNorm(320, 720, virtual)
  close(mid.fx, 0.5, 1e-12, '虚拟屏 (320,720) fx=0.5')
  close(mid.fy, 0.5, 1e-12, '虚拟屏 (320,720) fy=0.5')
  const br = screenToNorm(2559, 1439, virtual)
  close(br.fx, 4479 / 4480, 1e-12, '右下角 fx=(w-1)/w')
  close(br.fy, 1439 / 1440, 1e-12, '右下角 fy=(h-1)/h')
  // 相对某台显示器（负原点副屏）的 fx/fy
  eq(normToScreen(0.5, 0.5, { x: -1920, y: 0, w: 1920, h: 1080 }), { x: -960, y: 540 }, '副屏区域中心 → (-960,540)')
  eq(normToScreen(1, 1, { x: -1920, y: 0, w: 1920, h: 1080 }), { x: -1, y: 1079 }, '副屏区域右下角 → (-1,1079)')
  eq(normToScreen(0, 0, { x: -1920, y: 0, w: 1920, h: 1080 }), { x: -1920, y: 0 }, '副屏区域左上角')
  eq(normToScreen(0.5, 0.5, { x: 0, y: 0, w: 2560, h: 1440 }), { x: 1280, y: 720 }, '主屏区域中心 → (1280,720)')
  eq(normToScreen(1, 1, { x: 0, y: 0, w: 2560, h: 1440 }), { x: 2559, y: 1439 }, '主屏区域右下角')

  // --- 混合 DPI 的 lattice 物理间距（逐点 scale）---
  const spAt = (tier, x, y) => latticeSpacingScreen(tier, screenScaleAt(nm, x, y))
  eq(spAt('coarse', 1280, 720), 270, '主屏 coarse = round(180*1.5)=270')
  eq(spAt('standard', 1280, 720), 135, '主屏 standard = 135')
  eq(spAt('fine', 1280, 720), 68, '主屏 fine = round(45*1.5)=68')
  eq(spAt('micro', 1280, 720), 34, '主屏 micro = round(22.5*1.5)=34')
  eq(spAt('coarse', -960, 540), 180, '副屏 coarse = 180')
  eq(spAt('standard', -960, 540), 90, '副屏 standard = 90')
  eq(spAt('fine', -960, 540), 45, '副屏 fine = 45')
  eq(spAt('micro', -960, 540), 23, '副屏 micro = round(22.5)=23')

  // --- 晶格吸附（共享虚拟屏原点，间距按点所在显示器取）---
  const originV = { originX: virtual.x, originY: virtual.y }
  const secSnap = snapToLattice(-900, 500, { ...originV, spacing: 90 })
  eq({ x: secSnap.x, y: secSnap.y }, { x: -930, y: 540 }, '副屏吸附：(-900,500) → (-930,540)（原点 -1920, 间距 90）')
  close(secSnap.distance, 50, 1e-9, '副屏吸附距离 50px')
  const mainSnap = snapToLattice(1000, 700, { ...originV, spacing: 135 })
  eq({ x: mainSnap.x, y: mainSnap.y }, { x: 1050, y: 675 }, '主屏吸附：原点 -1920 + spacing 135 → (1050,675)')
  close(mainSnap.distance, 55.9, 1e-9, '主屏吸附距离 55.9px')
  eq(cellOfPoint(-900, 500, { ...originV, spacing: 90 }), { col: 11, row: 5 }, '副屏点所在晶格格 (11,5)')
  eq(cellCenter(11, 5, { ...originV, spacing: 90 }), { x: -885, y: 495 }, '副屏格中心 (-885,495)')
  eq(cellOfPoint(1000, 700, { ...originV, spacing: 135 }), { col: 21, row: 5 }, '主屏点所在晶格格 (21,5)')

  // --- 跨屏负坐标：裁剪 / 合法性 / 缩放 ---
  eq(clampRect({ x: -2000, y: -100, w: 300, h: 200 }, virtual), { x: -1920, y: 0, w: 220, h: 100 }, '负原点矩形裁剪到虚拟屏（-2000..-1700 ∩ -1920..）')
  eq(clampRect({ x: -100, y: 0, w: 200, h: 100 }, virtual), { x: -100, y: 0, w: 200, h: 100 }, '虚拟屏内矩形保持不变')
  eq(clampRect({ x: 3000, y: 2000, w: 100, h: 100 }, virtual), null, '完全在虚拟屏外 → null')
  ok(pointInVirtual(-1920, 0, virtual) === true, '虚拟屏左上角(-1920,0)合法')
  ok(pointInVirtual(2559, 1439, virtual) === true, '虚拟屏右下角(2559,1439)合法')
  ok(pointInVirtual(2560, 1439, virtual) === false, 'x=虚拟屏右边界(2560)越界')
  ok(pointInVirtual(-1921, 0, virtual) === false, 'x=-1921 越界')
  ok(pointInVirtual(-1920, -1, virtual) === false, 'y=-1 越界')
  eq(clampPointToVirtual(-5000, -500, virtual), { x: -1920, y: 0 }, '远左/上点夹到虚拟屏左上')
  eq(clampPointToVirtual(5000, 5000, virtual), { x: 2559, y: 1439 }, '远右/下点夹到虚拟屏右下')
  eq(clampPointToVirtual(100, 100, virtual), { x: 100, y: 100 }, '屏内点不变')
  eq(zoomSourceRect(-1000, 500, 270, virtual), { x: -1135, y: 365, w: 270, h: 270 }, '副屏 zoom 源矩形')
  eq(zoomSourceRect(-1920, 500, 270, virtual), { x: -1920, y: 365, w: 270, h: 270 }, 'zoom 贴虚拟屏左边界')
  eq(zoomSourceRect(2500, 500, 270, virtual), { x: 2290, y: 365, w: 270, h: 270 }, 'zoom 贴虚拟屏右边界')
  eq(zoomSourceRect(-1000, 500, 270, { x: -1920, y: 0, w: 200, h: 150 }), { x: -1920, y: 0, w: 200, h: 150 }, '虚拟屏小于 size 时取整屏')

  // --- 混合 DPI 下的 binning / 图像校验 ---
  const scaleTarget = binningScale('target', 4480, 1440, 1600)
  close(scaleTarget, 1600 / 4480, 1e-12, '虚拟屏 target binning = 1600/4480')
  eq(captureOutputSize(4480, 1440, scaleTarget), { w: 1600, h: 514 }, '虚拟屏输出 1600x514')
  ok(validateLatticeInImage(34, scaleTarget).ok === true, '主屏 micro@target 仍在图像内 ≥8px')
  pass('B 混合 DPI 双屏（负原点选择/边界/DPI/映射/间距/跨屏负坐标/binning）')
}

// ---------------------------------------------------------------------------
// C. 混合 DPI：DIP → 物理 px 四舍五入（逐 scale）
// ---------------------------------------------------------------------------
{
  const table = [
    ['coarse', 1, 180],
    ['coarse', 1.25, 225],
    ['coarse', 1.5, 270],
    ['coarse', 2, 360],
    ['standard', 1, 90],
    ['standard', 1.25, 113], // 112.5 → 113（四舍五入）
    ['standard', 1.5, 135],
    ['standard', 2, 180],
    ['fine', 1, 45],
    ['fine', 1.25, 56], // 56.25 → 56
    ['fine', 1.5, 68], // 67.5 → 68
    ['fine', 2, 90],
    ['micro', 1, 23], // 22.5 → 23
    ['micro', 1.25, 28], // 28.125 → 28
    ['micro', 1.5, 34], // 33.75 → 34
    ['micro', 2, 45],
  ]
  for (const [tier, scale, want] of table) {
    eq(latticeSpacingScreen(tier, scale), want, `${tier} DIP ${latticeDip(tier)} * scale ${scale} → ${want}px`)
  }
  // 非法/缺失 scale 一律按 1x 处理（不是按主屏 scale，也不是 0）
  eq(latticeSpacingScreen('standard', undefined), 90, 'scale 缺失 → 1x')
  eq(latticeSpacingScreen('standard', 0), 90, 'scale=0 → 1x')
  eq(latticeSpacingScreen('standard', -2), 90, '负 scale → 1x')
  eq(latticeSpacingScreen('standard', NaN), 90, 'NaN scale → 1x')
  eq(latticeSpacingScreen('standard', '1.5'), 135, '数字字符串 scale 也接受')
  eq(latticeSpacingScreen(null, 2), 0, 'lattice=off → 0')
  pass('C 混合 DPI 下 lattice 物理间距四舍五入 + 非法 scale 回退 1x')
}

// ---------------------------------------------------------------------------
// D. 0 尺寸 / 非法 monitors 输入（fail-closed，不产生幻影显示器）
// ---------------------------------------------------------------------------
{
  eq(normalizeMonitors(undefined), [], 'undefined → []')
  eq(normalizeMonitors(null), [], 'null → []')
  eq(normalizeMonitors('x'), [], '字符串 → []')
  eq(normalizeMonitors(42), [], '数字 → []')
  eq(normalizeMonitors([]), [], '空数组 → []')
  eq(
    normalizeMonitors([
      null,
      42,
      'x',
      {},
      { w: 0, h: 100 },
      { w: 100, h: 0 },
      { x: 0, y: 0, w: -5, h: 10 },
      { x: 0, y: 0, w: 'abc', h: 10 },
    ]),
    [],
    '0 尺寸/缺失/非法尺寸条目被跳过（不生成 1x1 幻影显示器）',
  )
  const one = normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100, scale: 0 }])
  eq(one.length, 1, '有效尺寸 + 非法 scale 仍保留显示器')
  eq(one[0].scale, 1, 'scale=0/非法 → 回退 1x（不是 0.25）')
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100, scale: 10 }])[0].scale, 8, 'scale 上界 8')
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100, scale: 0.1 }])[0].scale, 0.25, 'scale 下界 0.25')
  // 数字字符串（容错 helper JSON）
  const str = normalizeMonitors([{ x: '-1920', y: '0', w: '1920', h: '1080', scale: '1.5' }])
  eq(str.length, 1, '数字字符串尺寸可解析')
  eq({ x: str[0].x, y: str[0].y, w: str[0].w, h: str[0].h, scale: str[0].scale }, { x: -1920, y: 0, w: 1920, h: 1080, scale: 1.5 }, '数字字符串归一化为数字')
  eq(normalizeMonitors([{ x: 'abc', y: 0, w: 100, h: 100 }])[0].x, 0, 'x 非法 → 0')
  // primary 容错（helper 可能给 1/"true"；index.js 用 find(m=>m.primary) 找主屏算覆盖层间距）
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100, primary: 1 }])[0].primary, true, 'primary=1 → true')
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100, primary: 'true' }])[0].primary, true, 'primary="true" → true')
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100, primary: 'false' }])[0].primary, false, 'primary="false" → false')
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100 }])[0].primary, false, 'primary 缺失 → false')
  // id 保留 0，缺失用 1 基序号
  eq(normalizeMonitors([{ id: 0, x: 0, y: 0, w: 100, h: 100 }])[0].id, 0, 'id=0 保留')
  eq(normalizeMonitors([{ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 }]).map((m) => m.id).join(','), '1,2', '缺失 id 用 1 基序号')
  // 全部非法 → 虚拟屏回退 helper 的 virtual（支持负原点）
  eq(normalizeMonitors([{ w: 0 }, { h: 0 }]), [], '全部 0 尺寸 → 空列表')
  eq(virtualScreen([], { x: -1920, y: 0, w: 1920, h: 1080 }), { x: -1920, y: 0, w: 1920, h: 1080 }, '无显示器时回退 helper virtual（负原点）')
  eq(virtualScreen([]), { x: 0, y: 0, w: 0, h: 0 }, '无显示器无回退 → 0 尺寸')
  // 空列表上的查询
  eq(monitorAt([], 0, 0), null, '空 monitors → monitorAt null')
  eq(screenScaleAt([], 0, 0), 1, '空 monitors → scale 1（不崩）')
  eq(dpiAt([], 0, 0), 96, '空 monitors → 96 DPI')
  eq(monitorAt(nmOfMixed(), NaN, NaN), normalizeMonitors(MIXED_RAW)[1], '非数字点坐标按 (0,0) 处理（主屏）')
  // 映射函数对非法入参的容错
  eq(normToScreen(2, -1, { x: 0, y: 0, w: 100, h: 100 }), { x: 99, y: 0 }, 'fx/fy 超出 [0,1] 被夹取')
  eq(snapToLattice(500, 500, { originX: 0, originY: 0, spacing: 0 }), { x: 500, y: 500, dx: 0, dy: 0, distance: 0, onLattice: true }, 'spacing=0 回退 1px')
  eq(zoomSourceRect(100, 100, 1, { x: 0, y: 0, w: 800, h: 600 }), { x: 84, y: 84, w: 32, h: 32 }, 'zoom size 下界 32（以点为中心）')
  pass('D 0 尺寸/非法 monitors/非法坐标 fail-closed')
}

function nmOfMixed() {
  return normalizeMonitors(MIXED_RAW)
}

// ---------------------------------------------------------------------------
// E. 镜像/重叠显示器：同一矩形时优先主屏（DPI 取主屏）
// ---------------------------------------------------------------------------
{
  const mirror = normalizeMonitors([
    { id: 2, device: '\\\\.\\DISPLAY2', x: 0, y: 0, w: 1920, h: 1080, scale: 1.25 },
    { id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 1920, h: 1080, scale: 2 },
  ])
  eq(virtualScreen(mirror), { x: 0, y: 0, w: 1920, h: 1080 }, '镜像双屏虚拟屏 = 共享矩形')
  const hit = monitorAt(mirror, 500, 500)
  ok(hit !== null && hit.id === 1, '重叠矩形内优先返回主屏')
  eq(screenScaleAt(mirror, 500, 500), 2, '重叠矩形内 DPI 取主屏 scale=2')
  // 主屏排在后面的顺序也要优先
  const swapped = normalizeMonitors([mirror[0], mirror[1]])
  ok(monitorAt(swapped, 500, 500).id === 1, '顺序无关：主屏仍优先')
  // 虚拟屏外最近距离打平时也优先主屏（镜像时两台距离相同）
  const outsideHit = monitorAt(mirror, 2920, 500)
  ok(outsideHit !== null && outsideHit.scale === 2, '最近距离打平时优先主屏 scale')
  pass('E 镜像/重叠显示器优先主屏（DPI 正确）')
}

// ---------------------------------------------------------------------------
// F. 竖直堆叠（上下双屏，副屏在 y 负方向）
// ---------------------------------------------------------------------------
{
  const stacked = normalizeMonitors([
    { id: 1, device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 2560, h: 1440, scale: 1.5 },
    { id: 3, device: '\\\\.\\DISPLAY3', x: 0, y: -1200, w: 1920, h: 1200, scale: 1 },
  ])
  eq(virtualScreen(stacked), { x: 0, y: -1200, w: 2560, h: 2640 }, '上下双屏虚拟屏 y=-1200 h=2640')
  ok(monitorAt(stacked, 100, -1).id === 2 || monitorAt(stacked, 100, -1).id === 3, 'y=-1 命中上方副屏')
  ok(monitorAt(stacked, 100, 0).id === 1, 'y=0 命中主屏')
  ok(monitorAt(stacked, 0, -1200).id === 3, 'y 负边界命中副屏')
  eq(screenScaleAt(stacked, 100, -600), 1, '上方副屏 scale=1')
  eq(screenScaleAt(stacked, 100, 600), 1.5, '主屏 y 正区 scale=1.5')
  eq(normToScreen(0.5, 0.5, virtualScreen(stacked)), { x: 1280, y: 120 }, '垂直跨屏 fx/fy 映射（负 y 原点）')
  pass('F 竖直堆叠（上下屏/负 y 原点）')
}

// ---------------------------------------------------------------------------
// G. 幂等性：归一化结果再归一化不变（index.js 会反复 normalize 已归一化数据）
// ---------------------------------------------------------------------------
{
  const once = normalizeMonitors(MIXED_RAW)
  const twice = normalizeMonitors(once)
  eq(twice, once, 'normalizeMonitors 幂等（不会因 id/primary/scale 二次变化）')
  eq(virtualScreen(twice), virtualScreen(once), '幂等后虚拟屏一致')
  eq(screenScaleAt(twice, 1280, 720), screenScaleAt(once, 1280, 720), '幂等后 DPI 一致')
  eq(monitorAt(twice, -1, 500), monitorAt(once, -1, 500), '幂等后显示器选择一致')
  pass('G normalizeMonitors 幂等')
}

console.log(`PASS tools/grid-smoke.mjs: ${checks} 项断言全部通过（多显示器/混合 DPI 模型）`)
