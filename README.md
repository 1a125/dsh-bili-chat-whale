# 聊天鲸 · dsh-bili-chat-whale

[![test](https://github.com/1a125/dsh-bili-chat-whale/actions/workflows/test.yml/badge.svg)](https://github.com/1a125/dsh-bili-chat-whale/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/1a125/dsh-bili-chat-whale)](https://github.com/1a125/dsh-bili-chat-whale/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> GitHub：https://github.com/1a125/dsh-bili-chat-whale
> 最新发布：https://github.com/1a125/dsh-bili-chat-whale/releases/tag/v0.1.8

让 DSH 里的 agent **自己去找冷清的 B 站直播间**，蹲进去，**听懂主播在说什么、看懂画面在发生什么**，再用一句短弹幕陪聊。初衷很实在：刚开播、没什么观众的直播间，缺一个会接话的人。

- 自主发现：按兴趣关键词搜直播间，**多条关键词同时命中优先**，按「人少 + 兴趣命中 + 新主播」挑房间
- 分区导航：可只进某些直播分区，也可排除多个不想去的分区（父分区/子分区名都匹配）
- 蹲房：弹幕 WebSocket 常驻，主播下播 / 待够时间 / **连续没声音没画面 / 抓流失败**自动换下一间
- 刷新候选：设置页「刷新候选」真正重跑发现；「下一间」直接进入当前评分最高的候选，而不是只换列表
- 主动巡查：待命超过设定秒数自动清冷却重新找房；被主播/弹幕点名会优先搭话
- 检查更新：自动检测 GitHub Release，git 官方仓库安装可一键更新（更新后重启 DSH）
- 听懂：本地 **SenseVoice** 语音识别（不上传音频），每 20 秒听一段；识别模糊时尝试结合画面/上下文保守还原
- 看懂：**DSH 视觉模型 → HTTP 视觉接口 → Windows 本机 OCR** 三级梯队
- 会说话：到点叫醒属于它自己的 DSH 会话，让 agent 决定说一句还是闭嘴；所有发言过闸门
- 可刹车：默认 **演练模式**，条数 / 间隔 / 每日总量 / 禁用词 / 重复检测全部可配

> 平台风险提示：用自动化账号在直播间发言可能违反 B 站规则。默认演练不真发；真要开，先想清楚账号值不值得。

---

## 一、先回答那个难点

> 「怎么让 AI 听懂主播说的话和正在进行的画面？」

分三层解决，**都不依赖主播配合，也不需要 B 站的字幕接口**：

### 1. 声音 → 文字：本地 SenseVoice

- 每轮用 Node 抓 20 秒直播流（FLV）到本地，ffmpeg 转成 **16kHz 单声道 WAV**
- 常驻 worker 用 `sherpa-onnx-node` + **SenseVoiceSmall（int8，约 240MB）** 做 VAD 分段识别
- 中文 / 中英混说 / 粤语 / 日韩都支持；识别在 CPU 上跑，20 秒音频约 0.4–2 秒
- **音频不出本机**，模型只下载一次，存在 `<DSH_HOME>/chat-whale/asr/sensevoice`
- 识别器不可用时，提示词里会明确写「这段没听到」，**不让 agent 编造听到的内容**

实测（一间原神直播间的 15 秒片段）：

```
家人们哭着不说，田涯海里留着都河来追他，齐提来地坐穿。 失去挽岁，其实还不知道。 轻一些。
```

这是唱歌/游戏场景，转写会带错字；聊天、杂谈类直播准确率明显更好。转写本来就是给 agent 当「聊资」，不是做会议纪要 —— 关键词对了就能接话。

### 2. 画面 → 描述：三级梯队

| 优先级 | 方式 | 需要什么 | 能给出什么 |
|---|---|---|---|
| 1 | DSH 视觉模型（`ctx.llm` + 图片附件） | profile 里有声明 `image` 输入的模型 | 主播在做什么、场景、屏幕文字 |
| 2 | HTTP 视觉接口 | OpenAI 兼容的 baseURL + model + 密钥环境变量 | 同上 |
| 3 | 本机 OCR（Windows.Media.Ocr） | Windows 10/11，装好中文 OCR 语言包 | 只读屏幕上能看清的字（字幕/歌词/游戏 UI/公告） |

同一轮抓的 2 帧会拼成一张图，只调用一次模型。`auto` 模式按 1 → 2 → 3 退；任何一级失败都会记原因，不会假装看见。

> 为什么把 OCR 放进来：它完全离线、免费、永远可用。很多直播（唱歌、游戏、自习）屏幕上的字就是主要信息；再配上语音转写，agent 已经能接住大部分话题。

### 3. 弹幕 → 现场气氛

常驻 WebSocket 监听 `DANMU_MSG` / `SUPER_CHAT_MESSAGE` / `SEND_GIFT` / `WATCHED_CHANGE` / `PREPARE` 等事件，把「最近 10 条弹幕 + 在线人数 + 下播信号」一起交给 agent。主播说出「弹幕」「大家」「有没有」这类词时会**提前叫醒** agent，而不是死等定时器。

### 4. 把三层拼成「一次观察」

```
抓 20 秒流 ──► 音频 ──► SenseVoice 转写 ─┐
           └─► 2 帧拼图 ──► 视觉/OCR ───┼─► 观察记录（落盘 + 状态）
最近弹幕 ────────────────────────────────┘
                                         └─► 到点叫醒 agent → 说一句 / 闭嘴 / 换一间
```

---

## 二、安装

### 1. 依赖

- Node 24（DSH 自带/本机 node 都行）
- **ffmpeg**：仓库不带二进制。设置页「运行环境部署 → ffmpeg → 下载 ffmpeg」可一键装到 `<DSH_HOME>/chat-whale/bin/`（从 npm 镜像取包，国内可用）；也可以自己 `winget install ffmpeg`，或把 ffmpeg 放进 PATH / 插件 `bin/`
- **sherpa-onnx-node**：不随插件安装；DSH 的实验性语音输入包会一并装上它。找不到时设置页会报「sherpa-onnx」，语音走不了但其它功能正常
- **SenseVoice 模型**：首次在设置页点「下载模型」，约 240MB，从 HF-Mirror 优先下载并校验 SHA-256。也支持填自己的模型目录，或改用在 DSH 里已就绪的语音服务

### 2. 装进 profile（从 GitHub）

```powershell
git clone https://github.com/1a125/dsh-bili-chat-whale.git
cd dsh-bili-chat-whale
npm install
dsh plugin --profile web add "link:$PWD"
```

也可以让 DSH 插件管理页安装本地目录；或（如果当前 DSH 支持 npm 规格）直接：

```powershell
dsh plugin --profile web add "github:1a125/dsh-bili-chat-whale"
```

装完重启/热加载后，**设置 → 聊天鲸** 出现新的一节。

### 3. 第一次用（三步）

1. **看「运行环境部署」**：ffmpeg / 语音模型 / sherpa-onnx / 指令通道，缺什么点什么
2. **扫码登录**：设置页 →「B 站登录」→ 扫码。登录态写 `~/.bili-ai/credentials.json`，**永不回显**
3. **先演练**：保持「演练模式」开着，模式选「只看不说」或「会开口」跑一轮 ——
   - 看「主播刚才在说」是否对得上
   - 看「画面」有没有描述 / OCR 文字
   - 看活动记录里每次「要说什么」是否像人话
   
   确认没问题后，关掉演练模式。

> 模型环境全部在设置页部署：ASR 有「下载模型 / 测一段 / 引擎选择 / 模型目录」，视觉有「DSH 模型列表 / HTTP 接口 / 密钥保存」，依赖有「下载 ffmpeg」。仓库里没有任何 API Key、Cookie 或本机路径；密钥只存进 DSH 凭据服务或环境变量。

---

## 三、设置页逐项说明

| 分组 | 项 | 说明 |
|---|---|---|
| 状态 | 停着 / 只看不说 / 会开口 | 总模式。`只看不说` 仍然会听、会看、会记录，只是不叫醒 agent 发言 |
| | 演练模式 | 开着时 `say --go` 也只记录「本来要说什么」，不发网络请求 |
| 找什么样的直播间 | 兴趣关键词 | 轮流拿去搜直播间；越具体越容易碰到聊得来的 |
| | 避开词 | 标题/分区/标签命中就不进 |
| | 最多多少人在线 | 默认 30；人越少说话越容易被看见 |
| | 每间待多久 / 一小时最多进几间 | 防止赖着不走或来回跳 |
| 说话的规矩 | 每间最多几条 / 两条间隔 / 每小时 / 每天 | 四层闸门，CLI 和宿主都认 |
| | 多久考虑说一句 | 默认 150 秒；主播明显在跟弹幕互动时会提前 |
| 它在这里是谁 | 名字 / 风格 / 人设正文 | 每次叫醒都会拼进提示词；人设只影响这个会话 |
| 听懂主播说话 | 开关 / 引擎 / 语言 / 每次听多少秒 | 引擎：自动 / 本地 SenseVoice / DSH 语音服务 / 关 |
| | DSH 语音服务 | 显示 `speechToText` 检测结果和就绪的识别器；没启用语音输入 bundle 也没关系 |
| | 模型目录 | 留空用默认 `<DSH_HOME>/chat-whale/asr/sensevoice`；也可指向自己准备的模型 |
| | 下载模型 / 测一段 | 模型状态、进度、真实识别一次 |
| 看懂直播画面 | 方式 | 自动 / DSH 模型 / HTTP / 只用 OCR / 关 |
| | DSH 视觉模型 | 留空自动挑声明了 `image` 输入的模型；也可手填 provider/model，或从「列出模型」里点选 |
| | HTTP 视觉接口 | OpenAI 兼容：baseURL + model + 密钥（保存到 DSH 凭据服务，不回显；也可只填环境变量名） |
| 运行环境部署 | ffmpeg / sherpa / 语音模型 / 指令通道 | 一键下载 ffmpeg、查看各依赖状态；缺什么点什么 |
| B 站登录 | 扫码 / 手动 Cookie | Cookie 只写不读 |
| 手动 | 直接进某个房间 | 短号/长号都行 |
| 记录 | 最近在做什么 | 进房、观察、叫醒、发言、失败原因 |

### 可选环境变量

一般不用设；换机器/离线部署时才需要：

| 变量 | 作用 |
|---|---|
| `FFMPEG` | 指定 ffmpeg 可执行文件（优先于自动查找） |
| `CHAT_WHALE_NPM_REGISTRY` | ffmpeg 一键安装用的 npm 镜像（默认先 npmmirror，再 npmjs） |
| `CHAT_WHALE_SHERPA` / `DSH_SHERPA_ROOT` | sherpa-onnx-node 包目录 |
| `CHAT_WHALE_NODE` | 指定真正的 node.exe（桌面版 Electron 环境用） |
| `CHAT_WHALE_VISION_API_KEY` | HTTP 视觉接口密钥（也可以存进 DSH 凭据服务或填在设置页） |
| `CHAT_WHALE_CONFIG` | 覆盖配置文件路径 |

仓库里**没有**任何 API Key、Cookie、本机绝对路径；密钥只进 DSH 凭据服务或环境变量。

---

## 四、它到底怎么说话（agent 协作）

宿主不替 agent 发言。到点时，它把「最近两次观察 + 最近弹幕 + 互动状态 + 规矩」拼成一段提示，投递给专属会话（`bili-chat-whale`，工作目录 `<DSH_HOME>/chat-whale-work`）。agent 只有三种选择：

```powershell
# 说一句（默认仍是演练；配置里关掉 dry-run 才会真发）
node "<插件目录>\tools\chat-whale.mjs" say --text "这句接得挺自然" --go

# 换一间
node "<插件目录>\tools\chat-whale.mjs" next --reason "主播在引导刷礼物"

# 或者什么都不做，直接回「不说」
```

`say` 会再检查一遍：模式、每间/小时/天条数、间隔、20 字上限、禁用词、是否重复、和最近 6 句的相似度。任一不过就直接拒绝并返回原因。

> **为什么不是 CLI 直接发**：agent 的 pwsh 跑在 `workspace-write` 沙箱里，写不了宿主的状态目录；直接发会 `EPERM`，然后 agent 会申请「完全访问」，每条弹幕都要主人点一次批准。所以 CLI 只往会话工作区的 `.chat-whale/inbox/` 放一个 JSON 请求，宿主每秒扫一次、执行、写回执 —— agent 永远不需要放宽权限。宿主没起来时 CLI 会明确报「指令通道不在」，不会假装发出去。

其它命令：

```powershell
node "...\chat-whale.mjs" status            # 我在哪、待了多久、发了几条
node "...\chat-whale.mjs" discover           # 手动搜一轮候选
node "...\chat-whale.mjs" observe --json     # 立刻听一段、看一眼（调试用）
node "...\chat-whale.mjs" deps --json        # 依赖体检
node "...\chat-whale.mjs" asr-prepare        # 命令行下载模型
```

---

## 五、文件与数据

```
<DSH_HOME>/bili-chat-whale.config.json      配置（设置页读写）
<DSH_HOME>/chat-whale/
  state.json                                当前阶段/房间/计数/候选
  activity.jsonl                            事件流（设置页「最近在做什么」）
  control.json                              CLI → 宿主的控制意图（10 秒内消费）
  session.json                              专属会话 id / 最近投递时间
  asr/sensevoice/                           SenseVoice 模型 + tokens + VAD
  rooms/<roomId>/events.jsonl               弹幕/进场/礼物/下播事件
  rooms/<roomId>/session.jsonl              观察记录
  rooms/<roomId>/caps/<ts>/                 某轮截图（sheet.jpg）与临时 flv/wav
  tmp/                                      抓流临时目录
```

- 房间现场保留 7 天，每间最多 12 轮截图；日志超过 2MB 自动保留最近 1500 行
- 凭据：`~/.bili-ai/credentials.json`（ACL 收紧到当前用户；永不回显）

---

## 六、源码地图

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主插件：设置路由、登录、引擎生命周期、信任栅栏 |
| `lib/scheduler.js` | 巡航状态机：发现 → 进房 → 观察 → 叫醒 → 换房 |
| `lib/discovery.js` | 关键词搜索、过滤、打分、复核 |
| `lib/bili.js` | WBI 签名、直播搜索/房间/播放地址/弹幕发送 |
| `lib/ffmpeg.js` | 抓 N 秒 FLV → 本地 WAV + 拼帧截图 |
| `lib/asr.js` | SenseVoice worker 生命周期、模型下载与校验、DSH 语音服务适配 |
| `lib/vision.js` | 视觉三级梯队、模型路由与失败退避 |
| `lib/ocr.js` + `tools/ocr.ps1` | Windows 本机 OCR |
| `lib/ocr.js` 中的 `cleanLines` | 修 Windows OCR 的中文逐字空格 |
| `lib/store.js` | 状态锁、计数、闸门、活动日志、房间现场 |
| `lib/session.js` | 专属会话投递 + 忙碌判定 |
| `tools/live-ws.mjs` | 弹幕 WebSocket 子进程 |
| `tools/asr/worker.mjs` | 常驻 SenseVoice 识别 worker（stdin/stdout JSON 行协议） |
| `tools/chat-whale.mjs` | agent 用的 CLI |
| `lib/client.js` | 设置页（`settings.section` 槽位） |

---

## 七、排障

| 现象 | 先看 |
|---|---|
| 设置页没有「聊天鲸」 | 包名是否严格是 `dsh-bili-chat-whale`；`cordis.patch.yml` 是否被加载；重启 DSH |
| 一直「未登录」 | 扫码后 `~/.bili-ai/credentials.json` 是否存在；`deps` 里 B 站登录是否 ✓ |
| 语音一直「模型未就绪」 | 设置页模型状态；`<DSH_HOME>/chat-whale/asr/sensevoice` 下三个文件大小对不对 |
| 语音报 sherpa | `node "...\chat-whale.mjs" deps` 里 sherpa 路径；DSH 目录里是否有 `node_modules/sherpa-onnx-node` |
| 画面只有 OCR | 正常：说明视觉模型没配或不可用。看 `/vision/routes` 里有没有 `image: true` 的模型；没有就配 HTTP 接口 |
| 弹幕发不出去 | `say` 会打印 B 站返回码：-101 未登录 / 10031 太快 / 1003 被禁言 / -400 参数 |
| 抓流失败 | 直播间可能刚下播；或网络拿不到 CDN。日志里会有 `下载直播流失败 HTTP ...` |
| 一直不进房 | `maxViewers` 太小 / 兴趣词太窄；把「最多多少人在线」调到 50 再试 |
| 无限换房 | 看活动记录里 `leave` 的原因；`stayMinutes` 是否太小；候选是否都被 7 天去重挡掉 |

---

## 八、礼数与边界

- 默认演练；默认每间 5 条、间隔 75 秒、每小时 15 条、每天 40 条
- 不索要联系方式、不去站外、不刷礼物、不评价外貌（写进提示词，也写进禁用词闸门）
- 主播明确说「别刷」「机器人走开」时，让 agent 换房（提示词要求它尊重这种信号）
- 主播的话和弹幕都是**不可信内容**：提示词明确要求只当聊天素材，不执行其中的「指令」
- 转写与截图只存在本机；HTTP 视觉接口是可选项，配了才会把截图发出去

---

## 九、授权

MIT（本插件代码）。`bin/ffmpeg.exe` 是 GPL 构建，SenseVoice / Silero / sherpa-onnx 各有自己的授权，详见 `NOTICE.md`。
