// dsh-desktop-hands —— 单包骨架（第 1 步）→ 融合核心（③④⑤⑥ 逐步落这里）。
//
// 本层不注册任何工具：34 个工具（23 + 6 + 5）由 cordis.patch.yml 的三行 insert 提供。
//
// ③ 拒绝清单下沉：apply 时把随包 core/deny-list.json 播种到共享数据目录
// （~/.dsh/dsh-desktop-hands/deny-list.json），三引擎各自读这一份；缺才写、原子写。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { seedDenyList } from './core/policy.mjs'

export function apply() {
  try {
    seedDenyList(join(homedir(), '.dsh', 'dsh-desktop-hands'))
  } catch {
    /* 播种失败不影响工具加载：各引擎回退各自内置清单 */
  }
}
