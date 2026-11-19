/**
 * dsh-click-matrix — Client half (v0.3).
 *
 * Composer status chip for the desktop-control plugin:
 *   - polls the read-only Host status route and shows mode / timed arm countdown /
 *     keep-on latch / human-activity suspension,
 *   - menu offers duration presets (30s / 2min / 10min), a keep-on toggle,
 *     stop, overlay toggle and doctor, executed by submitting /click-matrix
 *     commands through the composer inputActions (same as a human typing them).
 *
 * Module id must equal the package/loader name (dsh-click-matrix).
 */
window.__ModuleLoader__.load({
  id: 'dsh-click-matrix',
  factory: (require) => {
    const React = require('react')

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      bg: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      danger: '#e5484d',
      ok: '#30a46c',
      warn: '#f5a623',
    }

    function submitCommand(props, line) {
      const actions = props && props.inputActions
      if (!actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') return false
      try {
        actions.setDraft(line)
        setTimeout(() => {
          try { actions.submit() } catch (e) { /* ignore */ }
        }, 40)
        return true
      } catch (e) {
        return false
      }
    }

    function Dot(color) {
      return React.createElement('span', {
        style: {
          width: 7, height: 7, borderRadius: '50%', background: color,
          display: 'inline-block', flex: 'none',
        },
      })
    }

    function Chip(props) {
      const [status, setStatus] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [flash, setFlash] = React.useState('')
      const rootRef = React.useRef(null)

      // 点击菜单/芯片以外的地方 → 自动收回（否则授权上拉栏会一直挂在那）。
      React.useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch('/api/click-matrix/status', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (alive) setStatus(j && j.ok ? j : null) })
            .catch(() => { if (alive) setStatus(null) })
        }
        load()
        const timer = setInterval(load, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const armed = !!(status && status.armed)
      const latched = !!(status && status.latched)
      const paused = !!(status && status.paused)
      const suspended = status && status.suspended ? status.suspended : null
      const mode = status ? status.mode : '?'
      const remaining = status && Number.isFinite(status.remainingMs) ? Math.max(0, Math.round(status.remainingMs / 1000)) : 0
      const resumeIn = suspended ? Math.max(0, Math.ceil((suspended.resumeInMs || 0) / 1000)) : 0
      const needsAck = !!(status && status.needsReack)
      const auditBad = !!(status && status.auditWritable === false)
      const dotColor = needsAck || auditBad ? C.danger : paused ? C.danger : suspended ? C.warn : latched || armed ? C.ok : C.warn
      const label = needsAck
        ? '需确认重启'
        : auditBad
          ? '审计不可写'
          : paused
            ? '已暂停'
            : suspended
              ? `人类操作中 ${resumeIn}s`
              : latched
                ? '常开'
                : armed
                  ? `已授权 ${remaining}s`
                  : '待授权'

      const run = (line) => {
        const ok = submitCommand(props, line)
        setFlash(ok ? '已提交' : '需在输入框输入：' + line)
        setTimeout(() => setFlash(''), 2200)
        setOpen(false)
      }

      const action = (text, line, color) => React.createElement('button', {
        key: text,
        onClick: (e) => { e.preventDefault(); e.stopPropagation(); run(line) },
        style: {
          display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
          background: 'transparent', border: 'none', color: color || C.text,
          padding: '5px 10px', fontSize: 12, borderRadius: 6,
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = C.bg2 },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
      }, text)

      const sep = React.createElement('div', {
        key: 'sep',
        style: { height: 1, background: C.border, margin: '4px 6px' },
      })

      const section = (text) => React.createElement('div', {
        style: { padding: '7px 10px 3px', fontSize: 10, fontWeight: 600, color: C.secondary, letterSpacing: '.4px' },
      }, text)

      const hint = (text) => React.createElement('div', {
        style: { padding: '4px 10px 6px', fontSize: 11, color: C.secondary, lineHeight: '16px' },
      }, text)

      const footer = status
        ? `${latched ? '常开授权' : armed ? `已授权 · 剩 ${remaining}s` : paused ? '已暂停' : suspended ? '人类操作中，稍候自动恢复' : '待授权'}${needsAck ? ' · 需确认重启' : ''}`
        : '状态未知'

      return React.createElement('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        React.createElement('button', {
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v) },
          title: 'click-matrix 屏幕点阵鼠标控制',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            background: C.bg2, color: C.text, border: '1px solid ' + C.border,
            borderRadius: 8, padding: '3px 9px', fontSize: 12, lineHeight: '18px',
          },
        }, React.createElement('span', { style: { fontSize: 13 } }, '🖱'), React.createElement('span', null, '屏幕控制'),
          Dot(dotColor), React.createElement('span', { style: { color: C.secondary } }, label)),
        flash ? React.createElement('div', {
          style: {
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, whiteSpace: 'nowrap',
            background: C.bg, border: '1px solid ' + C.border, borderRadius: 6,
            padding: '4px 8px', fontSize: 11, color: C.secondary, zIndex: 40,
          },
        }, flash) : null,
        open ? React.createElement('div', {
          style: {
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, width: 224,
            background: C.bg, border: '1px solid ' + C.border, borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.22)', padding: 4, zIndex: 40,
          },
        },
        section('授权'),
        action('30 秒', '/click-matrix arm 30'),
        action('2 分钟', '/click-matrix arm 120'),
        action('10 分钟', '/click-matrix arm 600'),
        latched ? action('关闭常开', '/click-matrix stop', C.danger) : action('常开（不过期）', '/click-matrix arm on'),
        sep,
        section('停止'),
        action('停止并解除授权', '/click-matrix stop', C.danger),
        hint('随时可停：按 Esc 立即停；Ctrl+Shift+F11 缓停（做完当前这一步才停）。'),
        sep,
        section('屏幕浮层'),
        action('显示（常驻晶格+胶囊）', '/click-matrix overlay on'),
        action('隐藏', '/click-matrix overlay off'),
        action('自动（授权时才显示）', '/click-matrix overlay auto'),
        sep,
        section('工具'),
        action('自检', '/click-matrix doctor'),
        React.createElement('div', {
          style: { padding: '5px 10px', fontSize: 11, color: C.secondary, borderTop: '1px solid ' + C.border, marginTop: 4 },
        }, footer),
        ) : null,
      )
    }

    /** Collapsible (accordion) row used by the settings section. */
    function Collapsible(props) {
      const [open, setOpen] = React.useState(!!props.defaultOpen)
      return React.createElement('div', { style: { borderBottom: '0.5px solid ' + C.border } },
        React.createElement('button', {
          onClick: () => setOpen((v) => !v),
          style: {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
            background: 'transparent', border: 'none', cursor: 'pointer', padding: '10px 0',
            fontSize: 13, color: C.text, textAlign: 'left', fontFamily: 'inherit',
          },
        },
        React.createElement('span', null, props.title),
        React.createElement('span', { style: { color: C.secondary, fontSize: 12, flex: 'none', marginLeft: 12 } },
          (props.summary ? props.summary + ' ' : '') + (open ? '▾' : '▸'))),
        open ? React.createElement('div', { style: { padding: '2px 0 8px' } }, props.children) : null)
    }

    function SettingsSection() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [saved, setSaved] = React.useState('')

      React.useEffect(() => {
        let alive = true
        fetch('/api/click-matrix/config', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!alive) return
            if (j && j.ok && j.config) setData(j)
            else setErr('配置读取失败（插件可能未启用）')
          })
          .catch(() => { if (alive) setErr('配置读取失败（插件可能未启用）') })
        return () => { alive = false }
      }, [])

      const cfg = data && data.config ? data.config : null
      const flash = (msg) => { setSaved(msg); setTimeout(() => setSaved(''), 2600) }

      const save = (key, value) => {
        fetch('/api/click-matrix/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        })
          .then((r) => r.json())
          .then((j) => {
            if (j && j.ok) {
              setData((prev) => (prev ? { ...prev, config: { ...prev.config, [key]: j.value } } : prev))
              setErr('')
              flash('已保存（重启 DSH 生效）')
            } else {
              setErr((j && j.error) || '保存失败')
            }
          })
          .catch(() => setErr('保存失败'))
      }

      const rowStyle = {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18,
        padding: '8px 0', borderBottom: '0.5px solid ' + C.border, fontSize: 13, lineHeight: '20px',
      }
      const inputStyle = {
        width: 116, padding: '3px 8px', fontSize: 12, textAlign: 'right',
        color: C.text, background: C.bg2, border: '1px solid ' + C.border, borderRadius: 6,
      }

      const numRow = (label, key, min, max, step, unit) => React.createElement('div', { key, style: rowStyle },
        React.createElement('span', { style: { color: C.secondary } }, label),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none' } },
          React.createElement('input', {
            type: 'number', min, max, step, defaultValue: cfg[key],
            style: inputStyle,
            onBlur: (e) => {
              const raw = String(e.target.value).trim()
              if (raw === '') return
              const v = Number(raw)
              if (Number.isFinite(v)) save(key, v)
            },
          }),
          unit ? React.createElement('span', { style: { color: C.secondary, fontSize: 11, width: 28 } }, unit) : null,
        ))

      const boolRow = (label, key) => React.createElement('div', { key, style: rowStyle },
        React.createElement('span', { style: { color: C.secondary } }, label),
        React.createElement('input', {
          type: 'checkbox', checked: !!cfg[key],
          style: { cursor: 'pointer' },
          onChange: (e) => save(key, e.target.checked),
        }))

      const listRow = (label, key, hint) => React.createElement('div', { key, style: { padding: '8px 0', borderBottom: '0.5px solid ' + C.border, fontSize: 13 } },
        React.createElement('div', { style: { color: C.secondary, marginBottom: 4 } }, label),
        React.createElement('textarea', {
          rows: 3, defaultValue: (Array.isArray(cfg[key]) ? cfg[key] : []).join('\n'),
          style: {
            width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit',
            padding: '4px 8px', color: C.text, background: C.bg2, border: '1px solid ' + C.border,
            borderRadius: 6, resize: 'vertical',
          },
          onBlur: (e) => save(key, String(e.target.value).split(/[\n,，、]+/).map((s) => s.trim()).filter(Boolean)),
        }),
        React.createElement('div', { style: { color: C.secondary, fontSize: 11, marginTop: 2 } }, hint))

      const count = (a) => (Array.isArray(a) ? a.length : 0)
      const sec = (title, summary, defaultOpen, children) => React.createElement(Collapsible, {
        title, summary, defaultOpen,
      }, children)
      // 非名单分块：保持常展开（只有「填名单」的块需要收起来）。
      const section = (title, rows) => React.createElement('div', { style: { marginTop: 12 } },
        React.createElement('div', { style: { fontSize: 11, fontWeight: 600, color: C.secondary, letterSpacing: '.4px', padding: '2px 0 4px' } }, title),
        rows)

      if (err && !cfg) {
        return React.createElement('div', { style: { padding: '16px 0', color: C.secondary, fontSize: 13 } }, err)
      }
      if (!cfg) {
        return React.createElement('div', { style: { padding: '16px 0', color: C.secondary, fontSize: 13 } }, '读取中…')
      }

      const builtin = Array.isArray(data.builtinDeny) ? data.builtinDeny : []
      const builtinRows = builtin.map((g) => React.createElement('div', {
        key: g.id, style: { padding: '8px 0', borderBottom: '0.5px solid ' + C.border },
      },
      React.createElement('div', { style: { fontSize: 12, color: C.text, marginBottom: 2 } },
        `${g.label}（${count(g.processes)} 进程 · ${count(g.titleExact) + count(g.titleNeedles)} 标题）`),
      React.createElement('div', { style: { fontSize: 11, color: C.secondary, lineHeight: '17px' } },
        [...(g.processes || []), ...(g.titleExact || []), ...(g.titleNeedles || [])].join('、'))))

      return React.createElement('div', { style: { padding: '4px 0' } },
        React.createElement('div', { style: { fontSize: 12, color: C.secondary, padding: '2px 0 4px', lineHeight: '18px' } },
          '改动即时保存到本机，重启 DSH 后生效。安全关键项（模式/急停要求/allowSelf）不在此处开放。'),
        saved ? React.createElement('div', { style: { fontSize: 12, color: C.ok, padding: '2px 0 6px' } }, saved) : null,
        err ? React.createElement('div', { style: { fontSize: 12, color: C.danger, padding: '2px 0 6px' } }, err) : null,

        // —— 名单（可编辑）在最上面 ——
        sec('拒绝名单', `${count(cfg.denyProcesses) + count(cfg.denyTitleContains)} 条`, false, [
          listRow('拒绝进程', 'denyProcesses', '每行一个进程名（可用逗号分隔）；内置安全清单不受影响。'),
          listRow('拒绝标题', 'denyTitleContains', '每行一个标题匹配串；内置安全清单不受影响。'),
        ]),
        sec('放行名单', `${count(cfg.allowProcesses) + count(cfg.allowTitleContains)} 条`, false, [
          listRow('放行进程', 'allowProcesses', '每行一个进程名（可用逗号分隔）；只用于豁免「申请」，盖不过「拒绝」。'),
          listRow('放行标题', 'allowTitleContains', '每行一个标题匹配串；只用于豁免「申请」，盖不过「拒绝」。'),
        ]),
        sec('申请名单', `${count(cfg.askProcesses) + count(cfg.askTitleContains)} 条`, false, [
          listRow('申请进程', 'askProcesses', '每行一个进程名（可用逗号分隔）；命中后工具返回「需人类确认」。'),
          listRow('申请标题', 'askTitleContains', '每行一个标题匹配串；命中后工具返回「需人类确认」。'),
        ]),

        // —— 内置安全清单（只读）——
        sec('内置安全清单（只读，DSH 自身 + 系统，永远拦截）', `${builtin.length} 组`, false,
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: 11, color: C.secondary, padding: '4px 0 6px' } },
              '这些内置规则永远最高优先，任何名单都盖不过它，也不能在此修改。'),
            builtinRows)),

        // —— 数值设置（常展开）——
        section('授权', [
          numRow('默认授权时长', 'armDefaultSeconds', 10, 86400, 10, '秒'),
          numRow('授权窗口跨度', 'armWindowMs', 1000, 300000, 1000, 'ms'),
          numRow('授权内点击上限', 'armClicks', 1, 100, 1, '次'),
          numRow('热键授权窗口', 'hotkeyArmMs', 5000, 600000, 5000, 'ms'),
        ]),
        section('成本预算', [
          numRow('每轮图片上限', 'maxImagesPerTurn', 0, 60, 1, '张'),
          numRow('每轮图片 token', 'maxImageTokensPerTurn', 0, 200000, 1000, 'tok'),
          numRow('动作最小间隔', 'minIntervalMs', 0, 5000, 10, 'ms'),
        ]),
        section('批量 / 等待', [
          numRow('单批动作上限', 'batchMaxActions', 1, 50, 1, '个'),
          numRow('等待默认超时', 'waitDefaultTimeoutMs', 200, 30000, 100, 'ms'),
          numRow('画面稳定阈值', 'waitStableMs', 50, 5000, 50, 'ms'),
        ]),
        section('人类活动', [
          numRow('空闲后自动恢复', 'humanIdleResumeMs', 2000, 300000, 1000, 'ms'),
          numRow('变更前等待人类', 'humanWaitMaxMs', 0, 60000, 1000, 'ms'),
          boolRow('人类操作时暂停注入', 'pauseOnHumanInput'),
        ]),
        section('能力开关', [
          boolRow('允许键盘输入', 'enableKeyboard'),
          boolRow('允许剪贴板', 'enableClipboard'),
          boolRow('授权时显示胶囊', 'pillOnArm'),
        ]),
        section('超时', [
          numRow('辅助超时', 'helperTimeoutMs', 1000, 120000, 1000, 'ms'),
          numRow('UIA 超时', 'uiaTimeoutMs', 500, 30000, 500, 'ms'),
        ]),
        section('审计', [
          numRow('审计上限', 'auditMaxBytes', 65536, 67108864, 65536, 'B'),
        ]),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      ctx.effect(() => slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'click-matrix-chip', order: 20, label: '点阵' },
        (props) => React.createElement(Chip, { inputActions: props && props.inputActions }),
      )), 'click-matrix: composer chip')
      // Settings page: a dedicated "屏幕控制" section (read-only config view).
      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'click-matrix', order: 100, label: () => '屏幕控制' },
        () => React.createElement(SettingsSection, {}),
      )), 'click-matrix: settings section')
    }

    return { inject: ['slots'], apply }
  },
})
