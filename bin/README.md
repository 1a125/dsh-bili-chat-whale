# bin/

Windows 的 ffmpeg.exe 不随仓库提交（体积大、且是 GPL 二进制）。

两种装法：

1. 设置页 →「运行环境部署 → ffmpeg → 下载 ffmpeg」一键安装（会从 npm 镜像取包，解到 `<DSH_HOME>/chat-whale/bin/ffmpeg.exe`）
2. 自己装：`winget install ffmpeg`，或把 `ffmpeg.exe` 放进本目录 / 设置环境变量 `FFMPEG`

macOS / Linux 直接用系统包管理器安装 ffmpeg 即可（插件会从 PATH 找）。
