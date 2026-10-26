# Changelog

## v0.1.0 — 首个公开版本

### 能做什么

- 自主巡航：按兴趣关键词搜 B 站直播间，按「人少 + 兴趣命中 + 新主播」挑房间
- 蹲房：弹幕 WebSocket 常驻；主播下播 / 待够时间自动换下一间
- 听懂：本地 SenseVoice（sherpa-onnx）实时转写；也可借用 DSH 的 `speechToText` 服务
- 看懂：DSH 视觉模型 → OpenAI 兼容 HTTP 视觉接口 → Windows 本机 OCR 三级回退
- 陪聊：到点叫醒专属 agent 会话，让 agent 决定说一句还是闭嘴；CLI 会再过一遍闸门
- 刹车：默认演练（dry-run）、每间/小时/天条数上限、间隔、20 字上限、禁用词、重复检测

### 部署接口（设置页）

- 「运行环境部署」：ffmpeg 一键下载（npmmirror → npmjs 回退）、sherpa-onnx、语音模型、指令通道状态
- 语音：引擎选择（auto/local/dsh/off）、DSH 语音服务检测、模型目录、下载 240MB SenseVoice（SHA-256 校验）、测一段
- 视觉：方式选择、DSH 视觉模型列表与点选、HTTP baseURL/model、API Key 存入 DSH 凭据服务（不回显）、理解最新画面

### 工程细节

- agent 的 pwsh 跑在 `workspace-write` 沙箱里，CLI 通过会话工作区的 `.chat-whale/inbox` 指令队列交给宿主执行，
  不需要「完全访问」权限，也不会每条弹幕弹一次审批
- 语音 worker 空闲 10 分钟自动退出；热重载会清理旧实例
- 所有可选 DSH 服务（llm / attachments / credentials / speechToText）都通过 `ctx.get()` 读取，不声明成硬依赖
- 19 个单元测试；GitHub Actions 在 Windows 上跑 `npm test`

### 已知限制

- B 站弹幕发送需要扫码登录；仓库默认演练模式，不会自动对外发言
- SenseVoice 对唱歌/GAME 场景的转写会有错字；它只作为聊天素材，不做逐字纪要
- 视觉语义依赖可用的视觉模型；没有时退回本机 OCR（只读屏幕文字）
- 设置页未做截图级视觉验收（开发环境没有浏览器控制），但槽位注册与接口挂载已验证
