# ONNXTTS Local Voice Studio / ONNXTTS 本地语音工作室

ONNXTTS turns pasted text into WAV or MP3 audio with Piper-compatible ONNX voices. The browser UI, models, generated audio, Python/Piper runtime, and FFmpeg runtime all stay inside the project. No `npm install`, system Python, Conda, or system FFmpeg is required.

ONNXTTS 使用 Piper 兼容的 ONNX 语音把粘贴的文本生成 WAV 或 MP3。浏览器界面、模型、生成的音频、Python/Piper 运行时和 FFmpeg 运行时都保存在项目内；无需执行 `npm install`，也不依赖系统 Python、Conda 或系统 FFmpeg。

## Requirements / 运行要求

Install Node.js 20 or newer. Windows x64 and Linux x86_64 have project-local runtime installers; Linux also needs the standard `sh` and `tar` utilities normally included with the operating system.

请安装 Node.js 20 或更高版本。Windows x64 与 Linux x86_64 都提供项目内运行时安装器；Linux 还需要操作系统通常自带的标准 `sh` 和 `tar` 工具。

## Quick start / 快速启动

### Windows

Double-click `start_onnxtts.cmd`, or run it from Command Prompt or PowerShell:

双击 `start_onnxtts.cmd`，或在命令提示符、PowerShell 中运行：

```cmd
start_onnxtts.cmd
start_onnxtts.cmd --port 5000
start_onnxtts.cmd -open
start_onnxtts.cmd -open --port 5000
```

The launcher first uses `node.exe` from `PATH`. If it is not there, it scans `C:\Program Files\nodejs\node.exe` through `F:\Program Files\nodejs\node.exe` in drive-letter order. Only after all four locations fail does it ask you to install Node.js.

启动器优先使用 `PATH` 中的 `node.exe`；如果没有找到，会按盘符顺序扫描 `C:\Program Files\nodejs\node.exe` 到 `F:\Program Files\nodejs\node.exe`。四个位置全部失败后才会提示安装 Node.js。

### Linux

Run the Linux launcher with `sh`:

使用 `sh` 运行 Linux 启动器：

```sh
sh ./start_onnxtts.sh
sh ./start_onnxtts.sh --port 5000
sh ./start_onnxtts.sh -open
sh ./start_onnxtts.sh -open --port 5000
```

After startup, open the address printed in the terminal. The default is <http://127.0.0.1:4317>. Press `Ctrl+C` to stop the server.

启动后请打开终端中显示的地址，默认为 <http://127.0.0.1:4317>。按 `Ctrl+C` 可停止服务。

Pass `-open` (or `--open`) to listen on `0.0.0.0` and allow other devices to connect through this computer's LAN IP, for example `http://192.168.1.20:4317`. You may also need to allow the port through the operating-system firewall.

传入 `-open`（或 `--open`）后，服务会监听 `0.0.0.0`，其他设备可以通过本机局域网 IP 访问，例如 `http://192.168.1.20:4317`。可能还需要在操作系统防火墙中放行该端口。

Open mode has no user authentication. Use it only on a trusted network; do not expose the port directly to the public internet.

开放模式没有用户身份验证。请只在可信网络中使用，不要把该端口直接暴露到公网。

## First launch and local runtime / 首次启动与本地运行时

On first launch, ONNXTTS automatically installs the runtime for the current platform under `.local-env`. Downloads are version-pinned and SHA-256-verified before use. Windows receives standalone CPython, pinned Windows wheels, and a Windows FFmpeg build; Linux receives standalone CPython, pinned manylinux wheels, and static FFmpeg/FFprobe binaries.

首次启动时，ONNXTTS 会在 `.local-env` 中自动安装当前平台的运行时。所有下载内容都固定版本，并在使用前校验 SHA-256。Windows 会安装独立 CPython、固定的 Windows wheels 和 Windows FFmpeg；Linux 会安装独立 CPython、固定的 manylinux wheels 以及静态 FFmpeg/FFprobe。

Manage the runtime manually with the command for your platform:

可以使用对应平台的命令手动管理运行时：

```cmd
set_local_env.cmd -status
set_local_env.cmd -install
set_local_env.cmd -clear
```

```sh
sh ./set_local_env.sh -status
sh ./set_local_env.sh -install
sh ./set_local_env.sh -clear
```

The `.local-env` directory is platform-specific. If ONNXTTS detects a runtime created by the other operating system, startup and installation stop without deleting or replacing anything. Run the shown `-clear` command manually on the current platform, then install or start again.

`.local-env` 是平台专用目录。如果 ONNXTTS 检测到另一个操作系统创建的运行时，启动和安装都会停止，不会删除或替换任何内容。请在当前平台手动执行提示中的 `-clear` 命令，再重新安装或启动。

`-clear` removes only this project's `.local-env`. Models and generated audio under `data` are not removed.

`-clear` 只删除当前项目的 `.local-env`，不会删除 `data` 下的模型和生成音频。

## Use the studio / 使用语音工作室

Open the plus menu in Voice Library to add a voice from Hugging Face or upload a custom voice. A supported voice consists of a matching `.onnx` and `.onnx.json` pair; an optional `MODEL_CARD` may sit beside them.

在 Voice Library 中打开加号菜单，可以从 Hugging Face 添加语音，也可以上传自定义语音。受支持的语音必须包含同名的 `.onnx` 与 `.onnx.json` 文件，也可以在同一目录放置可选的 `MODEL_CARD`。

For Hugging Face, paste a folder URL containing one matching pair or paste a direct `.onnx`/`.onnx.json` URL. A repository root containing several possible voices is rejected so that the selected model is unambiguous. Private or gated repositories may use a read token for that request; the token is not written to disk.

使用 Hugging Face 时，请粘贴只包含一组匹配文件的文件夹 URL，或直接粘贴 `.onnx`/`.onnx.json` URL。如果仓库根目录中存在多组候选语音，应用会拒绝该地址，以免模型选择不明确。私有或受限仓库可以为本次请求提供只读 token；token 不会写入磁盘。

Select a voice, paste the transcript, adjust speed, sentence silence, volume, speaker, and output format, then choose Generate. The Preview card shows sentence timestamps: the sentence currently being spoken receives a light highlight, and selecting any sentence seeks the player to its start. On portrait screens, the transcript and generated preview appear above Voice Library.

选择语音后，粘贴文本，调整语速、句间静音、音量、说话人和输出格式，再点击 Generate。Preview 卡片会显示句子时间戳：当前读到的句子会浅色高亮，点击任一句子可让播放器跳到该句开头。在竖屏中，文本和生成结果会排在 Voice Library 上方。

Use the theme toggle in the upper-right corner for Light or Dark mode. Recently used voices appear in Recent and are stored only in browser LocalStorage.

右上角的主题开关可以切换 Light/Dark 模式。最近使用的语音会显示在 Recent 中，这项记录只保存在浏览器 LocalStorage。

The folder button immediately to the left of the Light/Dark switch opens Previous recordings. Alphabetic scripts are labeled with their first one or two words; scripts that do not use spelled-out words are shown with up to their first 32 characters. The Sort button cycles through newest, oldest, A–Z, and Z–A. Select one item and choose Load to restore its script to the text box and its audio and sentence cues to Preview; loading does not start playback automatically.

Light/Dark 开关左边的文件夹按钮会打开 Previous recordings。拼写型文字以开头一到两个单词作为标题；不使用拼写单词的文字最多显示开头 32 个字符。Sort 按钮依次切换最新、最早、首字母正序和首字母倒序。选中一条记录并点击 Load，会把纯脚本文字放回文本框，并把音频与句子时间点放入 Preview；加载后不会自动播放。

Long-press any row to enter multi-select mode, then tap more rows as needed. Delete selected asks for confirmation once. Clear removes every recording managed by the library and deliberately asks for confirmation twice. Confirmations appear in a non-blocking bar that expands below the recording actions; every step also provides Cancel.

长按任一记录可进入多选模式，随后可以继续点选其他记录。Delete selected 会确认一次；Clear 会删除录音库管理的全部记录，并有意要求连续确认两次。确认过程会在录音操作区下方向下展开，不使用阻塞式 Alert，并且每一步都可以 Cancel。

## Files and storage / 文件与存储

Downloaded voices are stored in `data/models`, custom uploads in `data/models/custom`, and generated audio in `data/audio`. Temporary transfer and transcript files use `data/tmp`.

下载的语音保存在 `data/models`，自定义上传保存在 `data/models/custom`，生成音频保存在 `data/audio`；传输与文本临时文件使用 `data/tmp`。

Each successful generation keeps the WAV or MP3 bytes unchanged and writes a same-basename JSON sidecar containing the original script and sentence timestamps. Both files retain the UUID basename. Recordings created before sidecars were introduced cannot be reconstructed and therefore do not appear in Previous recordings.

每次成功生成都会保持 WAV 或 MP3 音频内容不变，并写入一个同名 JSON sidecar，保存原始脚本与句子时间戳；两者都保留 UUID 文件名。在 sidecar 功能加入前生成的旧音频无法补回脚本，因此不会显示在 Previous recordings 中。

Audio remains on disk until you use Delete selected or Clear in Previous recordings, or remove it manually. Library deletion removes the selected UUID audio and JSON together.

音频会一直保留在磁盘中，直到你在 Previous recordings 中使用 Delete selected 或 Clear，或手动删除。录音库删除操作会同时移除选中 UUID 对应的音频与 JSON。

## Optional settings / 可选设置

Command-line `--port` or `-p` has priority over `ONNXTTS_PORT`. The default host is local-only `127.0.0.1`.

命令行参数 `--port` 或 `-p` 的优先级高于 `ONNXTTS_PORT`；默认监听地址是仅本机可访问的 `127.0.0.1`。

| Variable / 变量 | Purpose / 用途 | Default / 默认值 |
| --- | --- | --- |
| `ONNXTTS_PORT` | Local HTTP port / 本地 HTTP 端口 | `4317` |
| `ONNXTTS_HOST` | Bind address / 监听地址 | `127.0.0.1` |
| `ONNXTTS_SYNTHESIS_WORKERS` | Simultaneous synthesis workers / 同时合成 worker 数 | CPU-based, max 4 / 按 CPU 推断，最多 4 |
| `ONNXTTS_SYNTHESIS_QUEUE_LIMIT` | Waiting-job limit / 等待任务上限 | worker-based, 4–16 / 按 worker 推断，4–16 |
| `ONNXTTS_PYTHON` | Custom Python interpreter / 自定义 Python 解释器 | platform-local / 当前平台本地路径 |
| `ONNXTTS_PIPER_RUNTIME` | Custom Piper package folder / 自定义 Piper 包目录 | `.local-env/packages` |
| `ONNXTTS_FFMPEG` | Custom FFmpeg executable / 自定义 FFmpeg 可执行文件 | platform-local / 当前平台本地路径 |
| `HF_TOKEN` | Optional Hugging Face read token / 可选 Hugging Face 只读 token | unset / 未设置 |

Custom runtime variables are intended for advanced troubleshooting. Ordinary use should leave them unset so the isolated project runtime is used.

自定义运行时变量主要用于高级排错；正常使用时应保持未设置，以使用项目内隔离运行时。

## Troubleshooting / 故障排查

If startup reports a runtime from the other platform, manually run the current platform's `set_local_env` command with `-clear`. This confirmation is intentionally never automatic.

如果启动提示存在另一个平台的运行时，请在当前平台手动执行 `set_local_env` 的 `-clear` 命令；这一确认操作有意不做自动化处理。

If runtime installation was interrupted, run `-status`, then run `-install` to repair missing components. Every cached download is checked again before reuse.

如果运行时安装被中断，请先执行 `-status`，再执行 `-install` 补齐缺少的组件；缓存下载在复用前都会重新校验。

Only Piper-compatible ONNX voices are supported. A generic ONNX TTS model may use a different tokenizer, phonemizer, tensor layout, speaker scheme, or vocoder and therefore cannot be loaded as a Piper voice.

目前只支持 Piper 兼容的 ONNX 语音。通用 ONNX TTS 模型可能采用不同的分词器、音素器、张量布局、说话人方案或声码器，因此不能直接当作 Piper 语音加载。

## Privacy and limits / 隐私与限制

Transcript text is sent only to the local ONNXTTS server. Network access is used for first-run runtime downloads and when you explicitly inspect or download a Hugging Face model.

输入文本只会发送到本机 ONNXTTS 服务。网络访问仅用于首次安装运行时，以及你明确要求检查或下载 Hugging Face 模型时。