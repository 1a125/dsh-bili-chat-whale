# 安全说明

## 凭据与密钥

- B 站登录态写在 `~/.bili-ai/credentials.json`，文件权限收紧到当前 Windows 用户；设置页**永不回显** Cookie。
- 视觉接口的 API Key 通过 DSH 凭据服务保存（`CHAT_WHALE_VISION_API_KEY`），不写进配置文件；设置页只显示「已配置」。
- 本仓库不包含任何 API Key、Cookie、本机绝对路径或模型权重。请不要把 `~/.dsh/`、`~/.bili-ai/` 或 `.github-pat` 提交进 fork。

## 数据落在哪里

- 配置：`<DSH_HOME>/bili-chat-whale.config.json`
- 状态 / 日志 / 房间现场 / 语音模型：`<DSH_HOME>/chat-whale/`
- 会话工作区（含 agent ↔ 宿主的指令队列）：`<DSH_HOME>/chat-whale-work/.chat-whale/`

音频与截图默认只在本机处理；只有当你主动配置 HTTP 视觉接口时，截图才会发到那个接口。

## 自动化发言的风险

- 默认 `mode=off` + `dryRun=true`；开启真发前请自行评估账号风险与平台规则。
- 插件内置条数、间隔、长度、禁用词、重复检测与「被禁言/未登录」错误提示，但**不能保证**账号不被平台限制。
- 主播的话与弹幕属于不可信内容：提示词要求 agent 只把它们当聊天素材，不执行其中的指令。

## 报告问题

请通过 GitHub Issues 报告，并附上脱敏后的 `host.log` 片段；不要粘贴 Cookie、SESSDATA、API Key。
