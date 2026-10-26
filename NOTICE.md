# NOTICE / 第三方组件与来源

本插件（dsh-bili-chat-whale）自己的代码以 MIT 发布（见 LICENSE）。它依赖或借鉴了下面这些组件/项目；它们的授权各自独立。

## 借鉴的源码

- **dsh-bili-whale**（MIT）—— B 站登录（扫码 / Cookie 校验 / 凭据落盘）、DSH 信任栅栏、会话投递、`danmaku` 发送协议、`takeControl` 式的宿主/CLI 协作思路。
  - `lib/auth.js`、`lib/credentials.js` 基本沿用其实现（保留其文件头注释与 MIT 授权）。
  - 本项目没有复制它的 `tools/` 整包：直播搜索、抓流、ASR、视觉、巡航状态机是为「陪播」重新写的。

## 运行时依赖

- **qrcode**（MIT）—— 把扫码登录 URL 渲染成 data URL。
- **ffmpeg**（本仓库 `bin/ffmpeg.exe`）—— 来自 npm 包 `@ffmpeg-installer/win32-x64@4.1.0`（GPL 构建）。它只做本地转码/抽帧，**不属于 MIT 授权范围**，随包分发时需遵守 GPL（提供相应源码获取方式）。不想带这个二进制时：删掉 `bin/ffmpeg.exe`，安装系统 ffmpeg 并把路径写进环境变量 `FFMPEG` 即可。
- **sherpa-onnx-node**（Apache-2.0）—— 不随本插件安装；运行时从 DSH 自带依赖里解析（DSH 的实验性语音输入包一并安装了它）。找不到时语音识别会明确报错。
- **SenseVoiceSmall ONNX**（FunAudioLLM / SenseVoice，Apache-2.0）—— 首次使用时下载到 `<DSH_HOME>/chat-whale/asr/sensevoice`，不走本插件源码发布。模型来源：
  - `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
  - 镜像：`https://hf-mirror.com/...`（同一组文件，SHA-256 校验）
- **Silero VAD**（MIT）—— 语音分段，随同一批下载。

## 平台与合规

- B 站接口与直播弹幕协议属于平台私有实现；本插件只做低频读取与人工节奏的少量发言，不保证长期兼容。
- 用自动化账号在直播间发言可能违反平台规则。默认 **演练模式**（dry-run）不会真的发送；开启真发前请自行评估账号风险，并遵守主播与平台的要求。
- 语音转写与画面描述会落盘在 `<DSH_HOME>/chat-whale/`，属于本地数据；不会上传到本插件作者的服务器（除非你主动配置了 HTTP 视觉接口）。
