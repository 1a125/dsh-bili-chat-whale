/**
 * dsh-bili-chat-whale —— 客户端半边：DSH「设置 → 聊天鲸」。
 *
 * 数据流：这个 section ⇄ /dsh-chat-whale/api/* ⇄ ~/.dsh/bili-chat-whale.config.json
 * 状态每 4 秒轮询一次；配置只在打开/保存/手动刷新时读，避免把正在编辑的内容冲掉。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-chat-whale',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const API = '/dsh-chat-whale/api'
    const CSS_TAG = 'dsh-bili-chat-whale/section.css'
    const CSS = [
      '.bcw{max-width:780px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}',
      '.bcw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.bcw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}',
      '.bcw-card{background:rgba(127,127,127,.06);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;margin-top:10px}',
      '.bcw-status-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.bcw-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}',
      '.bcw-dot.ok{background:#2fbf71}.bcw-dot.warn{background:#e6a23c}.bcw-dot.off{background:var(--dsw-alias-label-tertiary)}',
      '.bcw-mode{display:flex;gap:6px;flex-wrap:wrap}',
      '.bcw-tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;font-size:12px;line-height:24px;padding:0 12px;cursor:pointer}',
      '.bcw-tab.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.bcw-room{font-size:13px;line-height:20px}',
      '.bcw-room b{font-weight:600}',
      '.bcw-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.bcw-group{margin-top:16px;font-size:13px;font-weight:600;line-height:20px;display:flex;align-items:center;gap:8px}',
      '.bcw-rows{display:flex;flex-direction:column}',
      '.bcw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.bcw-row:last-child{border-bottom:none}',
      '.bcw-row>div:first-child{flex:1;min-width:200px}',
      '.bcw-label{font-size:13px;line-height:19px}',
      '.bcw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}',
      '.bcw-input,.bcw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:170px;max-width:320px;outline:none}',
      '.bcw-input:focus-visible,.bcw-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.bcw-input.wide{min-width:280px}',
      'textarea.bcw-input{height:auto;padding:8px;line-height:1.6;font-family:inherit;resize:vertical;width:100%;max-width:none}',
      '.bcw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);align-items:center}',
      '.bcw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}',
      '.bcw-btn:disabled{opacity:.5;cursor:default}',
      '.bcw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.bcw-btn3{background:transparent;border:none;color:var(--dsw-alias-state-error-primary);font-size:12px;cursor:pointer;padding:0 4px}',
      '.bcw-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:22px;padding:0 9px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary)}',
      '.bcw-pill.ok{color:#2fbf71}.bcw-pill.bad{color:var(--dsw-alias-state-error-primary)}',
      '.bcw-out{white-space:pre-wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:260px;overflow:auto;margin-top:8px}',
      '.bcw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}',
      '.bcw-note{color:#e6a23c;font-size:12px;line-height:18px;margin-top:6px}',
      '.bcw-obs{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:12px;margin-top:10px}',
      '@media(max-width:620px){.bcw-obs{grid-template-columns:1fr}}',
      '.bcw-quote{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;background:rgba(127,127,127,.08);border-radius:8px;padding:8px 10px;max-height:180px;overflow:auto}',
      '.bcw-shot{width:100%;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);display:block;object-fit:cover}',
      '.bcw-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}',
      '.bcw-log{display:flex;gap:8px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);border-bottom:.5px dashed var(--dsw-alias-border-l2);padding:4px 0}',
      '.bcw-log time{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}',
      '.bcw-log .k{flex:none;color:var(--dsw-alias-label-primary);opacity:.85}',
      '.bcw-bar{height:6px;border-radius:999px;background:rgba(127,127,127,.18);overflow:hidden;margin-top:6px}',
      '.bcw-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}',
      '.bcw-cand{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:6px 0;border-bottom:.5px dashed var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.bcw-cand:last-child{border-bottom:none}',
      '.bcw-cookie{display:flex;flex-direction:column;gap:8px;min-width:240px;max-width:100%}',
      '.bcw-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:rgba(127,127,127,.12);padding:1px 5px;border-radius:4px}',
    ].join('')

    const getPath = (obj, path) => path.reduce((value, key) => (value == null ? undefined : value[key]), obj)
    const setPath = (obj, path, value) => {
      const next = JSON.parse(JSON.stringify(obj ?? {}))
      let cursor = next
      for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i]
        if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = typeof path[i + 1] === 'number' ? [] : {}
        cursor = cursor[key]
      }
      cursor[path[path.length - 1]] = value
      return next
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        ...options,
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`)
      return result
    }

    const PHASE = { idle: '待命', searching: '在找房间', watching: '在直播间里', init: '未启动' }
    const MODE = { off: '停着', watch: '只看不说', interact: '会开口' }
    const fmtTime = (value) => {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value).slice(11, 19)
      return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
    const mins = (ms) => Math.max(0, Math.round((Date.now() - Number(ms ?? 0)) / 60000))
    const pct = (prepare) => (prepare?.total ? Math.min(100, Math.round((prepare.received / prepare.total) * 100)) : 0)
    const mb = (bytes) => `${Math.round(Number(bytes ?? 0) / 1024 / 1024)} MB`

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === 'undefined') return
        if (!document.getElementById(CSS_TAG)) {
          const style = document.createElement('style')
          style.id = CSS_TAG
          style.textContent = CSS
          document.head.appendChild(style)
        }
      }, [])
    }

    function Switch({ value, onChange, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': value ? 'true' : 'false',
        disabled,
        onClick: () => onChange(!value),
        style: {
          width: 38, height: 22, borderRadius: 999, border: 'none', cursor: disabled ? 'default' : 'pointer',
          background: value ? 'var(--dsw-alias-brand-primary)' : 'rgba(127,127,127,.35)',
          position: 'relative', flex: 'none', opacity: disabled ? 0.5 : 1,
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 3, left: value ? 19 : 3, width: 16, height: 16, borderRadius: 999,
          background: '#fff', transition: 'left .15s',
        },
      }))
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'bcw-row' },
        h('div', null,
          h('div', { className: 'bcw-label' }, label),
          hint ? h('div', { className: 'bcw-hint' }, hint) : null),
        children)
    }

    function ListInput({ value, onCommit, placeholder }) {
      const [text, setText] = useState(Array.isArray(value) ? value.join('，') : '')
      useEffect(() => { setText(Array.isArray(value) ? value.join('，') : '') }, [JSON.stringify(value ?? [])])
      const commit = () => onCommit(text.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean))
      return h('input', {
        className: 'bcw-input wide',
        value: text,
        placeholder,
        onChange: (event) => setText(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') commit() },
      })
    }

    function QrLogin({ disabled, onAccount, onActiveChange }) {
      const [qr, setQr] = useState(null)
      const [error, setError] = useState('')
      const flow = useRef({ generation: 0, id: null, timer: null })
      const call = async (name, body = {}) => {
        const response = await fetch(`${API}/auth/qr/${name}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok || !result.ok) throw new Error(result.error || '登录操作失败，请重试。')
        return result
      }
      const cancel = () => {
        flow.current.generation += 1
        clearTimeout(flow.current.timer)
        const id = flow.current.id
        flow.current.id = null
        if (id) void call('cancel', { id }).catch(() => {})
      }
      useEffect(() => () => cancel(), [])
      const start = async () => {
        cancel(); setError(''); setQr({ status: 'starting' })
        const generation = flow.current.generation
        try {
          const initial = await call('start')
          if (generation !== flow.current.generation) { void call('cancel', { id: initial.id }).catch(() => {}); return }
          flow.current.id = initial.id
          setQr(initial)
          const poll = async () => {
            try {
              const result = await call('poll', { id: initial.id })
              if (generation !== flow.current.generation) return
              setQr(result)
              if (result.status === 'success') { onAccount(result.account); flow.current.id = null }
              else if (['waiting', 'scanned'].includes(result.status)) flow.current.timer = setTimeout(poll, 2000)
            } catch (e) {
              if (generation !== flow.current.generation) return
              cancel(); setError(e.message); setQr({ status: 'error' })
            }
          }
          flow.current.timer = setTimeout(poll, 2000)
        } catch (e) {
          if (generation === flow.current.generation) { setError(e.message); setQr({ status: 'error' }) }
        }
      }
      const active = ['starting', 'waiting', 'scanned'].includes(qr?.status)
      useEffect(() => {
        onActiveChange(active)
        return () => onActiveChange(false)
      }, [active, onActiveChange])
      const status = {
        starting: '正在生成二维码…', waiting: '用哔哩哔哩 App 扫码登录。',
        scanned: '已扫码，请在手机上确认。', expired: '二维码已过期，请重新生成。',
        cancelled: '已取消，原登录态未改变。',
        success: qr?.account ? `已登录：${qr.account.name}（mid ${qr.account.mid}）` : '',
      }[qr?.status]
      return h('div', { className: 'bcw-cookie' },
        qr?.image ? h('img', { src: qr.image, alt: 'B 站登录二维码', width: 200, height: 200 }) : null,
        status ? h('div', { className: 'bcw-hint', role: 'status' }, status) : null,
        error || qr?.error ? h('div', { className: 'bcw-err', role: 'alert' }, error || qr.error) : null,
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { className: 'bcw-btn', onClick: start, disabled: disabled || active }, qr ? '重新生成' : '扫码登录'),
          active ? h('button', { className: 'bcw-btn bcw-btn2', onClick: () => { cancel(); setQr({ status: 'cancelled' }) } }, '取消') : null))
    }

    function ChatWhaleSection() {
      useStyleOnce()
      const [cfg, setCfg] = useState(null)
      const [savedJson, setSavedJson] = useState('')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')
      const [qrActive, setQrActive] = useState(false)
      const [cookie, setCookie] = useState({ sessdata: '', bili_jct: '', buvid3: '' })
      const [cookieMsg, setCookieMsg] = useState('')
      const [asrOut, setAsrOut] = useState('')
      const [visionOut, setVisionOut] = useState('')
      const [routes, setRoutes] = useState(null)
      const [shotAt, setShotAt] = useState(0)
      const [manualRoom, setManualRoom] = useState('')
      const [visionKey, setVisionKey] = useState('')
      const [keyMsg, setKeyMsg] = useState('')
      const [keyStatus, setKeyStatus] = useState(null)

      const load = useCallback(async () => {
        setErr('')
        try {
          const result = await api('/settings')
          setCfg(result.config)
          setSavedJson(JSON.stringify(result.config))
          setStatus({ ...result.scheduler, ...(result.state ? { state: result.state } : {}), engine: result.engines, credentials: result.credentials })
        } catch (error) {
          setErr(`读取配置失败：${error.message}`)
        }
      }, [])

      const poll = useCallback(async () => {
        try {
          const result = await api('/status')
          setStatus(result)
          if (result.state?.lastObservedAt) setShotAt(result.state.lastObservedAt)
        } catch {}
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => {
        poll()
        const timer = setInterval(poll, 4000)
        return () => clearInterval(timer)
      }, [poll])

      const set = (path, value) => setCfg((current) => setPath(current, path, value))

      const save = async () => {
        setBusy('save'); setErr(''); setMsg('')
        try {
          const result = await api('/settings', { method: 'POST', body: JSON.stringify({ config: cfg }) })
          setCfg(result.config)
          setSavedJson(JSON.stringify(result.config))
          setMsg('✓ 已保存，下一轮就按新配置跑')
          poll()
        } catch (error) { setErr(`保存失败：${error.message}`) } finally { setBusy('') }
      }

      const action = async (name, path, body, label) => {
        setBusy(name); setErr(''); setMsg('')
        try {
          const result = await api(path, { method: 'POST', body: body ? JSON.stringify(body) : '{}' })
          setMsg(`✓ ${label}${result.detail ? `：${result.detail}` : ''}`)
          poll()
          return result
        } catch (error) { setErr(`${label}失败：${error.message}`); return null } finally { setBusy('') }
      }

      const downloadModels = async () => {
        setBusy('asr-prepare'); setErr(''); setMsg('')
        try {
          await api('/asr/prepare', { method: 'POST', body: '{}' })
          setMsg('开始下载语音模型（约 240MB），进度看上面状态，不用关页面。')
        } catch (error) { setErr(error.message) } finally { setBusy('') }
      }

      const testAsr = async () => {
        setBusy('asr-test'); setAsrOut('正在抓 8 秒音频并识别…'); setErr('')
        try {
          const result = await api('/asr/test', { method: 'POST', body: JSON.stringify({ seconds: 8 }) })
          setAsrOut(result.text ? `✓ ${result.text}` : '（这段没听到清楚的人声；换个说话多的房间再试）')
        } catch (error) { setAsrOut('✗ ' + error.message) } finally { setBusy('') }
      }

      const testVision = async () => {
        setBusy('vision-test'); setVisionOut('正在理解最新一张画面…'); setErr('')
        try {
          const result = await api('/vision/test', { method: 'POST', body: '{}' })
          if (result.ok) setVisionOut(`✓ [${result.mode}] ${result.text}`)
          else setVisionOut(`✗ ${result.error}`)
          setShotAt(Date.now())
        } catch (error) { setVisionOut('✗ ' + error.message) } finally { setBusy('') }
      }

      const loadRoutes = async () => {
        setBusy('routes')
        try { setRoutes(await api('/vision/routes')) } catch (error) { setErr(error.message) } finally { setBusy('') }
      }

      const loadKeyStatus = useCallback(async () => {
        try { const result = await api('/vision/key'); setKeyStatus(result.key ?? null) } catch {}
      }, [])

      useEffect(() => { loadKeyStatus() }, [loadKeyStatus])

      const saveVisionKey = async () => {
        setBusy('vision-key'); setKeyMsg('')
        try {
          const result = await api('/vision/key', { method: 'POST', body: JSON.stringify({ key: visionKey }) })
          setKeyMsg(`✓ ${result.detail ?? '已保存'}`)
          setVisionKey('')
          loadKeyStatus()
          loadRoutes()
        } catch (error) { setKeyMsg('✗ ' + error.message) } finally { setBusy('') }
      }

      const clearVisionKey = async () => {
        setBusy('vision-key'); setKeyMsg('')
        try {
          await api('/vision/key', { method: 'DELETE' })
          setKeyMsg('✓ 已清除')
          loadKeyStatus()
          loadRoutes()
        } catch (error) { setKeyMsg('✗ ' + error.message) } finally { setBusy('') }
      }

      const installFfmpeg = async () => {
        setBusy('ffmpeg'); setErr(''); setMsg('')
        try {
          await api('/tools/ffmpeg/install', { method: 'POST', body: '{}' })
          setMsg('开始下载 ffmpeg（约 22MB），进度在「运行环境」里。')
          poll()
        } catch (error) { setErr('下载 ffmpeg 失败：' + error.message) } finally { setBusy('') }
      }

      /** 刷新候选列表：真正重跑一次发现，而不是只重新拉状态。 */
      const refreshCandidates = async () => {
        setBusy('refresh'); setErr(''); setMsg('')
        try {
          const result = await api('/discover', { method: 'POST', body: '{}' })
          setMsg(`✓ 刷新到 ${result.candidates?.length ?? 0} 个候选`)
          poll()
        } catch (error) { setErr('刷新候选失败：' + error.message) } finally { setBusy('') }
      }

      const saveCookie = async () => {
        setBusy('cookie'); setCookieMsg(''); setErr('')
        try {
          const result = await api('/cookie', { method: 'POST', body: JSON.stringify(cookie) })
          setCookieMsg(`✓ ${result.detail}`)
          setCookie({ sessdata: '', bili_jct: '', buvid3: '' })
          setCfg((current) => ({ ...current, self: result.self }))
          poll()
        } catch (error) { setCookieMsg('✗ ' + error.message) } finally { setBusy('') }
      }

      const updateAccount = ({ mid, name }) => {
        setCfg((current) => ({ ...current, self: { mid, name } }))
        setSavedJson((current) => {
          if (!current) return current
          const parsed = JSON.parse(current)
          parsed.self = { mid, name }
          return JSON.stringify(parsed)
        })
        poll()
      }

      if (!cfg) {
        return h('div', { className: 'bcw' },
          h('h3', { className: 'bcw-title' }, '聊天鲸'),
          err ? h('div', { className: 'bcw-err' }, err) : h('div', { className: 'bcw-hint' }, '读取中…'))
      }

      const dirty = savedJson && JSON.stringify(cfg) !== savedJson
      const scheduler = status ?? {}
      const room = scheduler.state?.room ?? scheduler.room ?? null
      const phase = scheduler.phase ?? scheduler.state?.phase ?? 'idle'
      const asrEngine = scheduler.engine?.asr ?? scheduler.asr ?? null
      const visionEngine = scheduler.engine?.vision ?? scheduler.vision ?? null
      const prepare = scheduler.prepare ?? null
      const models = scheduler.models ?? null
      const activity = scheduler.activity ?? []
      const candidates = scheduler.state?.candidates ?? scheduler.candidates ?? []
      const sheetUrl = room?.roomId ? `${API}/room-sheet?roomId=${room.roomId}&t=${shotAt || Date.now()}` : null
      const credOk = !!(scheduler.credentials?.hasSess ?? cfg.self?.mid)
      const asrReady = !!(asrEngine?.ready ?? models?.ready)
      const modelReady = !!models?.ready

      return h('div', { className: 'bcw' },
        h('h3', { className: 'bcw-title' }, '聊天鲸'),
        h('p', { className: 'bcw-intro' },
          '让 agent 自己找冷清的 B 站直播间，听懂主播说话、看懂画面，再用短弹幕陪聊。',
          h('br'),
          '配置写进 ', h('code', { className: 'bcw-code' }, '~/.dsh/bili-chat-whale.config.json'),
          '；登录态与「养鱼」共用同一个 B 站账号。'),

        // ── 状态 ───────────────────────────────────────────────────────────
        h('div', { className: 'bcw-card' },
          h('div', { className: 'bcw-status-head' },
            h('span', { className: `bcw-dot ${cfg.mode === 'off' ? 'off' : phase === 'watching' ? 'ok' : 'warn'}` }),
            h('b', null, cfg.mode === 'off' ? '停着' : `${MODE[cfg.mode] ?? cfg.mode} · ${PHASE[phase] ?? phase}`),
            h('span', { className: 'bcw-pill' }, cfg.interaction?.dryRun !== false ? '演练模式（不真发）' : '真发'),
            h('span', { className: `bcw-pill ${credOk ? 'ok' : 'bad'}` }, credOk ? `已登录${cfg.self?.name ? '：' + cfg.self.name : ''}` : '未登录'),
            h('span', { className: `bcw-pill ${modelReady ? 'ok' : 'bad'}` }, modelReady ? '语音模型就绪' : '语音模型未就绪'),
            h('span', { className: `bcw-pill ${scheduler.bridge?.alive ? 'ok' : 'bad'}` }, scheduler.bridge?.alive ? '指令通道正常' : '指令通道未启动'),
            h('span', { className: `bcw-pill ${visionEngine?.ocrAvailable ? 'ok' : ''}` }, `画面：${visionEngine?.ocrAvailable ? 'OCR 可用' : 'OCR 不可用'}`)),
          h('div', { className: 'bcw-mode' },
            ['off', 'watch', 'interact'].map((mode) => h('button', {
              key: mode, type: 'button',
              className: `bcw-tab ${cfg.mode === mode ? 'on' : ''}`,
              onClick: () => set(['mode'], mode),
            }, `${MODE[mode]}${mode === cfg.mode ? ' ·当前' : ''}`))),
          room
            ? h('div', { className: 'bcw-room' },
              h('b', null, room.title || '（标题读取中）'),
              ` · 主播 ${room.uname || '未知'} · 人气 ${room.online ?? '?'} · ${room.area || '未知分区'}`,
              h('br'),
              h('span', { className: 'bcw-muted' },
                `已待 ${mins(room.enteredAt)} 分钟 · 已发 ${room.spoken ?? 0} 条 · 观察 ${room.observations ?? 0} 次`,
                ` · 无内容 ${room.emptyStreak ?? 0}/${cfg.interests?.boringEmptyStreak ?? 4} · 抓流失败 ${room.captureFailStreak ?? 0}/${cfg.interests?.boringFailStreak ?? 3}`,
                scheduler.wsConnected ? ' · 弹幕连接正常' : ' · 弹幕连接断开'))
            : h('div', { className: 'bcw-muted' }, '现在不在任何直播间里。'),
          scheduler.lastError || scheduler.lastCaptureError
            ? h('div', { className: 'bcw-err' }, `最近问题：${scheduler.lastError || scheduler.lastCaptureError}`)
            : null,
          h('div', { className: 'bcw-actions', style: { borderTop: 'none', marginTop: 0, paddingTop: 0 } },
            h('button', { className: 'bcw-btn', onClick: () => action('next', '/next', {}, '找下一间'), disabled: !!busy || qrActive }, busy === 'next' ? '找下一间…' : '下一间（按优先级）'),
            h('button', { className: 'bcw-btn bcw-btn2', onClick: refreshCandidates, disabled: !!busy || qrActive }, busy === 'refresh' ? '刷新中…' : '刷新候选'),
            h('button', { className: 'bcw-btn bcw-btn2', onClick: () => action('observe', '/observe', {}, '观察一次'), disabled: !!busy || !room || qrActive }, busy === 'observe' ? '观察中…' : '听一段 / 看一眼'),
            h('button', { className: 'bcw-btn bcw-btn2', onClick: () => action('leave', '/leave', { reason: '设置页手动离开' }, '离开'), disabled: !!busy || !room || qrActive }, '离开'),
            h('button', { className: 'bcw-btn bcw-btn2', onClick: () => { setErr(''); setMsg(''); load(); poll() }, disabled: !!busy || qrActive }, '重新读取'))),

        // ── 现场 ───────────────────────────────────────────────────────────
        room
          ? h('div', { className: 'bcw-obs' },
            h('div', null,
              h('div', { className: 'bcw-label' }, '主播刚才在说（语音转写）'),
              h('div', { className: 'bcw-quote' }, room.lastTranscript || '（还没有听到清楚的人声）'),
              h('div', { className: 'bcw-label', style: { marginTop: 10 } }, '画面（最近一次）'),
              h('div', { className: 'bcw-quote' }, room.lastVision || (room.lastVisionError ? `（画面理解失败：${room.lastVisionError}）` : '（还没有画面描述）'))),
            h('div', null,
              h('div', { className: 'bcw-label' }, '最新画面'),
              sheetUrl ? h('img', { className: 'bcw-shot', src: sheetUrl, alt: '直播间画面' }) : h('div', { className: 'bcw-muted' }, '还没有截图')))
          : null,

        // ── 候选 ───────────────────────────────────────────────────────────
        candidates.length
          ? h('div', null,
            h('div', { className: 'bcw-group' }, '刚刚找到的候选'),
            h('div', { className: 'bcw-list' }, candidates.slice(0, 6).map((item) => h('div', { className: 'bcw-cand', key: item.roomId },
              h('div', null,
                h('div', { className: 'bcw-label' }, item.title || item.roomId),
                h('div', { className: 'bcw-hint' }, `${item.uname || '?'} · 人气 ${item.online} · ${item.parentArea ? item.parentArea + ' / ' : ''}${item.area || '?'} · 评分 ${item.score ?? '?'} · 命中 ${item.hits?.length ?? 0} 个关键词`)),
              h('button', {
                className: 'bcw-btn bcw-btn2', type: 'button', disabled: !!busy || qrActive,
                onClick: () => action('enter', '/enter', { roomId: item.roomId }, `进入 ${item.title || item.roomId}`),
              }, '进这间')))))
          : null,

        // ── 兴趣与发现 ─────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, '找什么样的直播间'),
        h('div', { className: 'bcw-rows' },
          h(Row, { label: '兴趣关键词', hint: '逗号分隔。每轮轮流搜最多 4 个词；同时命中多条的房间优先；留空则用「刚开播/聊天/新人…」宽泛词。分区限制也会参与搜索' },
            h(ListInput, { value: cfg.interests?.keywords, onCommit: (list) => set(['interests', 'keywords'], list), placeholder: '聊天，编程，唱歌…' })),
          h(Row, { label: '避开词', hint: '标题/分区/标签里出现这些词就不进' },
            h(ListInput, { value: cfg.interests?.avoidKeywords, onCommit: (list) => set(['interests', 'avoidKeywords'], list), placeholder: '带货，擦边…' })),
          h(Row, { label: '只进这些分区', hint: '父分区/子分区名都行，例如：娱乐、网游、学习、电台；留空 = 不限' },
            h(ListInput, { value: cfg.interests?.includeAreas, onCommit: (list) => set(['interests', 'includeAreas'], list), placeholder: '娱乐，学习，电台…' })),
          h(Row, { label: '不进这些分区', hint: '命中父分区或子分区名就跳过，例如：手游、颜值、带货' },
            h(ListInput, { value: cfg.interests?.excludeAreas, onCommit: (list) => set(['interests', 'excludeAreas'], list), placeholder: '手游，颜值…' })),
          h(Row, { label: '人气上限', hint: 'B 站公开接口只有人气值，不是精确在线人数；默认 3000。想更冷清可设 500，设 0 = 不限' },
            h('input', { className: 'bcw-input', type: 'number', min: 0, max: 1000000, value: cfg.interests?.maxPopularity ?? 3000, onChange: (e) => set(['interests', 'maxPopularity'], Number(e.target.value)) })),
          h(Row, { label: '每间待多久（分钟）', hint: '到点自动换下一间；默认 8 分钟' },
            h('input', { className: 'bcw-input', type: 'number', min: 1, max: 180, value: cfg.interests?.stayMinutes ?? 8, onChange: (e) => set(['interests', 'stayMinutes'], Number(e.target.value)) })),
          h(Row, { label: '一小时最多进几间', hint: '默认 4；防止来回跳' },
            h('input', { className: 'bcw-input', type: 'number', min: 1, max: 30, value: cfg.interests?.roomsPerHour ?? 4, onChange: (e) => set(['interests', 'roomsPerHour'], Number(e.target.value)) })),
          h(Row, { label: '没内容时主动换台', hint: '连续几轮听不到人声、画面也没字，或抓流连续失败（断流/没画面），就主动去下一间' },
            h(Switch, { value: cfg.interests?.autoLeaveBoring !== false, onChange: (value) => set(['interests', 'autoLeaveBoring'], value) })),
          h(Row, { label: '连续几轮没内容就换', hint: '默认 4 轮；按每次听的秒数算，大约 2 分钟' },
            h('input', { className: 'bcw-input', type: 'number', min: 2, max: 20, value: cfg.interests?.boringEmptyStreak ?? 4, onChange: (e) => set(['interests', 'boringEmptyStreak'], Number(e.target.value)) })),
          h(Row, { label: '抓流连续失败几次就换', hint: '默认 3 次；404/断流/抽不到画面都算' },
            h('input', { className: 'bcw-input', type: 'number', min: 2, max: 10, value: cfg.interests?.boringFailStreak ?? 3, onChange: (e) => set(['interests', 'boringFailStreak'], Number(e.target.value)) }))),

        // ── 互动 ───────────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, '说话的规矩'),
        h('div', { className: 'bcw-rows' },
          h(Row, { label: '演练模式', hint: '开着时绝不真发，只记录「本来要说什么」。建议先开几天看看' },
            h(Switch, { value: cfg.interaction?.dryRun !== false, onChange: (value) => set(['interaction', 'dryRun'], value) })),
          h(Row, { label: '每间最多几条', hint: '默认 5；说完就安静待着' },
            h('input', { className: 'bcw-input', type: 'number', min: 0, max: 30, value: cfg.interaction?.maxPerRoom ?? 5, onChange: (e) => set(['interaction', 'maxPerRoom'], Number(e.target.value)) })),
          h(Row, { label: '两条之间至少隔（秒）', hint: '默认 75 秒；低于 20 秒会被 B 站限速' },
            h('input', { className: 'bcw-input', type: 'number', min: 20, max: 3600, value: cfg.interaction?.minGapSec ?? 75, onChange: (e) => set(['interaction', 'minGapSec'], Number(e.target.value)) })),
          h(Row, { label: '一小时 / 一天最多几条', hint: '两层总量闸门，防止越聊越上头' },
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', { className: 'bcw-input', type: 'number', min: 0, max: 120, style: { minWidth: 90 }, value: cfg.interaction?.maxPerHour ?? 15, onChange: (e) => set(['interaction', 'maxPerHour'], Number(e.target.value)) }),
              h('input', { className: 'bcw-input', type: 'number', min: 0, max: 500, style: { minWidth: 90 }, value: cfg.interaction?.maxPerDay ?? 40, onChange: (e) => set(['interaction', 'maxPerDay'], Number(e.target.value)) }))),
          h(Row, { label: '多久考虑说一句（秒）', hint: '默认 150 秒；主播的话明显在跟弹幕互动时会提前叫醒你' },
            h('input', { className: 'bcw-input', type: 'number', min: 45, max: 3600, value: cfg.interaction?.speakIntervalSec ?? 150, onChange: (e) => set(['interaction', 'speakIntervalSec'], Number(e.target.value)) }))),

        // ── 人设 ───────────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, '它在这里是谁'),
        h('div', { className: 'bcw-rows' },
          h(Row, { label: '名字', hint: '直播间的昵称感；不要用真名' },
            h('input', { className: 'bcw-input', value: cfg.persona?.name ?? '', onChange: (e) => set(['persona', 'name'], e.target.value) })),
          h(Row, { label: '说话风格', hint: '一两句就够，越具体越像人' },
            h('input', { className: 'bcw-input wide', value: cfg.persona?.tone ?? '', onChange: (e) => set(['persona', 'tone'], e.target.value) })),
          h(Row, { label: '人设正文（可空）', hint: '写它在意什么、怎么接话、绝对不做什么；每次叫醒都会带上' },
            h('textarea', { className: 'bcw-input', rows: 5, value: cfg.persona?.bio ?? '', onChange: (e) => set(['persona', 'bio'], e.target.value), placeholder: '比如：一个下班后喜欢蹲小主播直播间的人，会接梗但不抢话；不评价主播外貌，不劝刷礼物。' })),
          h(Row, { label: '主人 mid / 昵称', hint: '在弹幕里认出主人；可留空' },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('input', { className: 'bcw-input', style: { minWidth: 120 }, value: cfg.owner?.mid ?? '', onChange: (e) => set(['owner', 'mid'], e.target.value), placeholder: 'mid' }),
              h('input', { className: 'bcw-input', style: { minWidth: 120 }, value: cfg.owner?.name ?? '', onChange: (e) => set(['owner', 'name'], e.target.value), placeholder: '昵称' })))),

        // ── 听 ─────────────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, '听懂主播说话'),
        h('div', { className: 'bcw-rows' },
          h(Row, { label: '开启语音识别', hint: '本地 SenseVoice 模型；不上传音频' },
            h(Switch, { value: cfg.voice?.enabled !== false, onChange: (value) => set(['voice', 'enabled'], value) })),
          h(Row, { label: '识别引擎', hint: 'auto = 优先借 DSH 语音服务，没启用就下载本地 SenseVoice' },
            h('select', { className: 'bcw-select', value: cfg.voice?.engine ?? 'auto', onChange: (e) => set(['voice', 'engine'], e.target.value) },
              [['auto', '自动（推荐）'], ['local', '本地 SenseVoice'], ['dsh', 'DSH 语音服务'], ['off', '关']].map(([value, label]) => h('option', { key: value, value }, label)))),
          h(Row, { label: 'DSH 语音服务', hint: asrEngine?.service?.available ? `已检测到 speechToText；就绪 ${(asrEngine.service.providers ?? []).filter((p) => p.phase === 'ready' || p.phase === 'standby').length} 个识别器` : '当前 profile 没启用语音输入 bundle（没关系，用本地模型即可）' },
            h('div', { className: 'bcw-hint' },
              (asrEngine?.service?.providers ?? []).length
                ? (asrEngine.service.providers ?? []).map((p) => `${p.id}（${p.phase}）`).join(' · ')
                : '未检测到')),
          h(Row, { label: '模型目录', hint: '留空用默认 <DSH_HOME>/chat-whale/asr/sensevoice；也可以指向自己准备好的模型' },
            h('input', { className: 'bcw-input wide', placeholder: '留空用默认目录', value: cfg.voice?.modelDir ?? '', onChange: (e) => set(['voice', 'modelDir'], e.target.value) })),
          h(Row, { label: '语言', hint: '中文主播选 zh；中英混说也能识别' },
            h('select', { className: 'bcw-select', value: cfg.voice?.language ?? 'zh', onChange: (e) => set(['voice', 'language'], e.target.value) },
              [['zh', '中文'], ['auto', '自动'], ['en', '英文'], ['yue', '粤语'], ['ja', '日文'], ['ko', '韩文']].map(([value, label]) => h('option', { key: value, value }, label)))),
          h(Row, { label: '每次听多少秒', hint: '默认 20 秒；太长会更吃 CPU' },
            h('input', { className: 'bcw-input', type: 'number', min: 6, max: 60, value: cfg.voice?.clipSeconds ?? 20, onChange: (e) => set(['voice', 'clipSeconds'], Number(e.target.value)) })),
          h(Row, { label: '模型状态', hint: models?.ready ? `已就绪：${models.dir}` : `缺少 ${(models?.missing ?? []).join('、') || '模型'}（约 240MB）` },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: downloadModels, disabled: !!busy || qrActive || prepare?.running }, prepare?.running ? '下载中…' : modelReady ? '重新检查' : '下载模型'),
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: testAsr, disabled: !!busy || qrActive || !asrReady }, busy === 'asr-test' ? '识别中…' : '测一段'))),
          prepare?.running
            ? h('div', null,
              h('div', { className: 'bcw-hint' }, `${prepare.file ?? '准备中'}：${mb(prepare.received)} / ${mb(prepare.total)}`),
              h('div', { className: 'bcw-bar' }, h('i', { style: { width: `${pct(prepare)}%` } })))
            : null,
          asrOut ? h('div', { className: 'bcw-out' }, asrOut) : null),

        // ── 看 ─────────────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, '看懂直播画面'),
        h('div', { className: 'bcw-rows' },
          h(Row, { label: '开启画面理解', hint: '关掉就只靠声音和弹幕；不会假装看见' },
            h(Switch, { value: cfg.vision?.enabled !== false, onChange: (value) => set(['vision', 'enabled'], value) })),
          h(Row, { label: '方式', hint: 'auto = 先试视觉模型，不行退 HTTP 接口，最后用本机 OCR' },
            h('select', { className: 'bcw-select', value: cfg.vision?.mode ?? 'auto', onChange: (e) => set(['vision', 'mode'], e.target.value) },
              [['auto', '自动（推荐）'], ['llm', 'DSH 视觉模型'], ['http', 'HTTP 视觉接口'], ['ocr', '只用本机 OCR'], ['off', '关']].map(([value, label]) => h('option', { key: value, value }, label)))),
          h(Row, { label: 'DSH 视觉模型', hint: '留空自动挑一个声明了图片输入的模型；也可手填 provider/model' },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('input', { className: 'bcw-input', style: { minWidth: 110 }, placeholder: 'provider', value: cfg.vision?.provider ?? '', onChange: (e) => set(['vision', 'provider'], e.target.value) }),
              h('input', { className: 'bcw-input', style: { minWidth: 130 }, placeholder: 'model', value: cfg.vision?.model ?? '', onChange: (e) => set(['vision', 'model'], e.target.value) }))),
          h(Row, { label: 'HTTP 视觉接口（可选）', hint: 'OpenAI 兼容：baseURL + model + 密钥环境变量名。用于 DSH 模型不支持图片时' },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', flexDirection: 'column', alignItems: 'flex-end' } },
              h('input', { className: 'bcw-input wide', placeholder: 'https://api.example.com', value: cfg.vision?.baseURL ?? '', onChange: (e) => set(['vision', 'baseURL'], e.target.value) }),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('input', { className: 'bcw-input', style: { minWidth: 130 }, placeholder: 'model', value: cfg.vision?.model && !cfg.vision?.provider ? cfg.vision.model : '', onChange: (e) => set(['vision', 'httpModel'], e.target.value) }),
                h('input', { className: 'bcw-input', style: { minWidth: 150 }, placeholder: '密钥环境变量名', value: cfg.vision?.apiKeyEnv ?? '', onChange: (e) => set(['vision', 'apiKeyEnv'], e.target.value) })))),
          h(Row, {
            label: '接口密钥',
            hint: (keyStatus?.configured ?? routes?.key?.configured)
              ? `已配置（${keyStatus?.ref ?? routes?.key?.ref ?? '凭据服务'}），不会回显`
              : '存在 DSH 凭据服务里，不写进配置文件；也可以只填上面的环境变量名',
          },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              h('input', {
                className: 'bcw-input', type: 'password', autoComplete: 'off',
                placeholder: (keyStatus?.configured ?? routes?.key?.configured) ? '已保存（输入新值可覆盖）' : '粘贴 API Key',
                value: visionKey, onChange: (e) => setVisionKey(e.target.value),
              }),
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: saveVisionKey, disabled: !!busy || qrActive || !visionKey }, busy === 'vision-key' ? '保存中…' : '保存密钥'),
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: clearVisionKey, disabled: !!busy || qrActive }, '清除'),
              keyMsg ? h('span', { className: keyMsg.startsWith('✓') ? 'bcw-hint' : 'bcw-err' }, keyMsg) : null)),
          h(Row, { label: '每次拼几帧 / 每间最多看几次', hint: '默认 2 帧拼一张；每间最多 40 次' },
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', { className: 'bcw-input', type: 'number', min: 1, max: 4, style: { minWidth: 90 }, value: cfg.vision?.frames ?? 2, onChange: (e) => set(['vision', 'frames'], Number(e.target.value)) }),
              h('input', { className: 'bcw-input', type: 'number', min: 0, max: 240, style: { minWidth: 90 }, value: cfg.vision?.maxPerRoom ?? 40, onChange: (e) => set(['vision', 'maxPerRoom'], Number(e.target.value)) }))),
          h(Row, { label: '测试与模型列表', hint: routes?.ok ? `列了 ${(routes.routes ?? []).length} 个模型（带 image 标记的可用）` : '点一下列出 DSH 里可用的视觉模型' },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: testVision, disabled: !!busy || qrActive || !room }, busy === 'vision-test' ? '理解中…' : '理解最新画面'),
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: loadRoutes, disabled: !!busy || qrActive }, '列出模型'))),
          routes?.ok && (routes.routes ?? []).some((item) => item.image)
            ? h('div', { className: 'bcw-hint' },
              '可选：',
              (routes.routes ?? []).filter((item) => item.image).slice(0, 12).map((item) => h('button', {
                key: `${item.provider}/${item.model}`, type: 'button', className: 'bcw-btn3', style: { color: 'var(--dsw-alias-brand-primary)' },
                onClick: () => setCfg((current) => setPath(setPath(current, ['vision', 'provider'], item.provider), ['vision', 'model'], item.model)),
              }, `${item.provider}/${item.model}`)))
            : null,
          visionOut ? h('div', { className: 'bcw-out' }, visionOut) : null),

        // ── 运行环境 ───────────────────────────────────────────────────────
        h('div', { className: 'bcw-card' },
          h('div', { className: 'bcw-group', style: { marginTop: 0 } }, '运行环境部署'),
          h('div', { className: 'bcw-hint' }, '装到别人机器上时，先看这里：缺什么就点什么。'),
          h('div', { className: 'bcw-rows' },
            h(Row, {
              label: 'ffmpeg',
              hint: scheduler.engine?.ffmpeg?.ok ? scheduler.engine.ffmpeg.detail : (scheduler.engine?.ffmpeg?.detail ?? '还没检测到'),
            },
              h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: installFfmpeg, disabled: !!busy || qrActive || scheduler.engine?.ffmpeg?.ok || scheduler.ffmpegInstall?.running },
                scheduler.ffmpegInstall?.running ? '下载中…' : scheduler.engine?.ffmpeg?.ok ? '已就绪' : '下载 ffmpeg')),
            h(Row, {
              label: 'sherpa-onnx',
              hint: asrEngine?.sherpa ? asrEngine.sherpa : '找不到：语音识别会不可用。它通常随 DSH 一起安装。',
            }, h('span', { className: asrEngine?.sherpa ? 'bcw-pill ok' : 'bcw-pill bad' }, asrEngine?.sherpa ? '已找到' : '缺失')),
            h(Row, {
              label: 'sherpa 目录（高级）',
              hint: '留空自动找；找不到时填 sherpa-onnx-node 包的绝对路径',
            }, h('input', { className: 'bcw-input wide', placeholder: '例如 ...\\node_modules\\sherpa-onnx-node', value: cfg.asr?.sherpaRoot ?? '', onChange: (e) => set(['asr', 'sherpaRoot'], e.target.value) })),
            h(Row, {
              label: '语音模型',
              hint: modelReady ? `本地模型已就绪：${models?.dir ?? ''}` : `未下载（约 240MB）；也可以用 DSH 语音服务`,
            }, h('span', { className: modelReady ? 'bcw-pill ok' : 'bcw-pill' }, modelReady ? '就绪' : '未下载')),
            h(Row, {
              label: '指令通道',
              hint: scheduler.bridge?.alive ? `宿主每秒处理一次：${scheduler.bridge.dir}` : '未启动：agent 的 say/next 会报错',
            }, h('span', { className: scheduler.bridge?.alive ? 'bcw-pill ok' : 'bcw-pill bad' }, scheduler.bridge?.alive ? `已处理 ${scheduler.bridge.handled ?? 0} 条` : '未启动'))),
          scheduler.ffmpegInstall?.running
            ? h('div', null,
              h('div', { className: 'bcw-hint' }, `ffmpeg：${mb(scheduler.ffmpegInstall.received)} / ${mb(scheduler.ffmpegInstall.total)}`),
              h('div', { className: 'bcw-bar' }, h('i', { style: { width: `${pct(scheduler.ffmpegInstall)}%` } })))
            : null,
          scheduler.ffmpegInstall?.error ? h('div', { className: 'bcw-err' }, scheduler.ffmpegInstall.error) : null),

        // ── 登录 ───────────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, 'B 站登录'),
        h('div', { className: 'bcw-rows' },
          h('div', { className: 'bcw-row' },
            h('div', null,
              h('div', { className: 'bcw-label' }, cfg.self?.mid ? `当前账号：${cfg.self.name}（${cfg.self.mid}）` : '连接 B 站账号（发弹幕必须）'),
              h('div', { className: 'bcw-hint' }, '手机扫码确认；失败或取消会保留原登录态。')),
            h(QrLogin, { disabled: !!busy, onAccount: updateAccount, onActiveChange: setQrActive })),
          h('details', null,
            h('summary', { className: 'bcw-hint', style: { cursor: 'pointer', marginTop: 6 } }, '手动导入 Cookie'),
            h('div', { className: 'bcw-rows' },
              h('div', { className: 'bcw-row' },
                h('div', null,
                  h('div', { className: 'bcw-label' }, '凭据'),
                  h('div', { className: 'bcw-hint' }, 'F12 → Application → Cookie 里复制；写入后永不回显。')),
                h('div', { className: 'bcw-cookie' },
                  h('input', { className: 'bcw-input', type: 'password', autoComplete: 'off', placeholder: 'SESSDATA', value: cookie.sessdata, onChange: (e) => setCookie((s) => ({ ...s, sessdata: e.target.value })) }),
                  h('input', { className: 'bcw-input', type: 'password', autoComplete: 'off', placeholder: 'bili_jct', value: cookie.bili_jct, onChange: (e) => setCookie((s) => ({ ...s, bili_jct: e.target.value })) }),
                  h('input', { className: 'bcw-input', type: 'password', autoComplete: 'off', placeholder: 'buvid3（可空）', value: cookie.buvid3, onChange: (e) => setCookie((s) => ({ ...s, buvid3: e.target.value })) }),
                  h('button', { className: 'bcw-btn bcw-btn2', type: 'button', onClick: saveCookie, disabled: !!busy || qrActive || !cookie.sessdata || !cookie.bili_jct }, busy === 'cookie' ? '写入中…' : '写入凭据'),
                  cookieMsg ? h('div', { className: cookieMsg.startsWith('✓') ? 'bcw-hint' : 'bcw-err' }, cookieMsg) : null))))),

        // ── 手动进房 ───────────────────────────────────────────────────────
        h('div', { className: 'bcw-group' }, '手动'),
        h('div', { className: 'bcw-rows' },
          h(Row, { label: '直接进某个房间', hint: '填房间号（短号也可以）' },
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', { className: 'bcw-input', placeholder: '例如 21452505', value: manualRoom, onChange: (e) => setManualRoom(e.target.value) }),
              h('button', {
                className: 'bcw-btn bcw-btn2', type: 'button', disabled: !!busy || qrActive || !manualRoom,
                onClick: () => action('enter', '/enter', { roomId: manualRoom.replace(/\D/g, '') }, `进入 ${manualRoom}`),
              }, '进入')))),

        // ── 记录 ───────────────────────────────────────────────────────────
        activity.length
          ? h('div', null,
            h('div', { className: 'bcw-group' }, '最近在做什么'),
            h('div', { className: 'bcw-list' }, activity.slice(0, 12).map((item, index) => h('div', { className: 'bcw-log', key: `${item.at ?? ''}-${index}` },
              h('time', null, fmtTime(item.at)),
              h('span', { className: 'k' }, item.kind),
              h('span', null, `${item.title ? '「' + item.title + '」' : ''}${item.text ? item.text : ''} ${item.detail ?? ''}`.trim())))))
          : null,

        h('div', { className: 'bcw-actions' },
          h('button', { className: 'bcw-btn', onClick: save, disabled: !!busy || qrActive }, busy === 'save' ? '保存中…' : '保存'),
          dirty ? h('span', { className: 'bcw-note' }, '● 有改动还没保存（不点保存 = 没生效）') : null,
          h('button', { className: 'bcw-btn bcw-btn2', onClick: load, disabled: !!busy || qrActive }, '重新读取')),

        err ? h('div', { className: 'bcw-err' }, err) : null,
        msg ? h('div', { className: 'bcw-out' }, msg) : null,
        h('div', { className: 'bcw-hint' },
          '第一次用：① 扫码登录 ② 下载语音模型 ③ 先保持演练模式跑一轮，看「主播刚才在说」是否对得上，再关掉演练。'))
    }

    const inject = ['slots']
    const NS = 'bili-chat-whale'
    const NAMES = { nav: '聊天鲸' }

    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: NS, order: 7, label: () => NAMES.nav },
          ChatWhaleSection,
        ), 'bili-chat-whale: settings section'),
        'bili-chat-whale: settings section',
      )
    }

    return { inject, apply, ChatWhaleSection }
  },
})
