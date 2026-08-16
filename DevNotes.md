# ONNXTTS Developer Notes / ONNXTTS 开发说明

This document contains implementation details and maintenance guidance. User-facing startup, workflow, storage, and troubleshooting instructions live in [README.md](README.md).

本文包含实现细节与维护说明。面向用户的启动、操作流程、存储和故障排查指南位于 [README.md](README.md)。

## Architecture / 架构

ONNXTTS is a local web application with a dependency-free Node.js ES module server and a native HTML/CSS/JavaScript client. Node owns HTTP, model discovery, downloads, uploads, request validation, and process orchestration; project-local Python owns Piper inference; project-local FFmpeg performs optional MP3 conversion.

ONNXTTS 是一个本地 Web 应用，服务端使用无第三方运行时依赖的 Node.js ES Modules，客户端使用原生 HTML/CSS/JavaScript。Node 负责 HTTP、模型发现、下载、上传、请求验证和进程编排；项目内 Python 负责 Piper 推理；项目内 FFmpeg 负责可选的 MP3 转换。

The normal request path is browser → Node HTTP validation and bounded FIFO queue → one worker thread per accepted job → isolated Python bridge → Piper/ONNX Runtime → WAV, followed by project-local FFmpeg when MP3 is requested.

正常请求链路为：浏览器 → Node HTTP 验证与有界 FIFO 队列 → 每个已接收任务独立的 worker thread → 隔离的 Python 桥接脚本 → Piper/ONNX Runtime → WAV；请求 MP3 时再调用项目内 FFmpeg。

| File / 文件 | Responsibility / 职责 |
| --- | --- |
| `server.mjs` | Composition root, model library, Hugging Face inspection/download, custom uploads / 组合入口、模型库、Hugging Face 检查与下载、自定义上传 |
| `server/web.js` | HTTP routes, parsers, static/media responses, error mapping, security headers / HTTP 路由、解析器、静态与媒体响应、错误映射、安全响应头 |
| `server/onnx-runtime.js` | Runtime selection, request preparation, CPU sizing, and worker dispatch / 运行时选择、任务准备、CPU 并发推断与 worker 派发 |
| `server/bounded-fifo-queue.js` | Generic bounded FIFO scheduling and overload errors / 通用有界 FIFO 调度与过载错误 |
| `server/synthesis-worker.js` | One-job Python/FFmpeg process orchestration and cleanup / 单任务 Python/FFmpeg 进程编排与清理 |
| `tools/synthesize_piper.py` | Sentence synthesis bridge and PCM timing metadata / 分句合成桥接与 PCM 时间元数据 |
| `tools/set_local_env.ps1` | Windows runtime installer and verifier / Windows 运行时安装与验证 |
| `set_local_env.sh` | Linux x86_64 runtime installer and verifier / Linux x86_64 运行时安装与验证 |
| `tools/download_runtime_asset.mjs` | Linux HTTPS downloader, cache reuse, and SHA-256 verification / Linux HTTPS 下载、缓存复用与 SHA-256 校验 |
| `public/*` | Page structure, themes, layout, model/recent/upload/generation interactions / 页面结构、主题、布局、模型、最近使用、上传与生成交互 |

## Project-local runtime layout / 项目内运行时布局

`.local-env` is intentionally platform-specific. Both platforms use `.local-env/packages` for explicitly loaded Python packages, but executable paths differ.

`.local-env` 有意设计为平台专用目录。两个平台都使用 `.local-env/packages` 存放显式加载的 Python 包，但可执行文件路径不同。

| Component / 组件 | Windows x64 | Linux x86_64 |
| --- | --- | --- |
| Python | `.local-env/python/python.exe` | `.local-env/python/bin/python3` |
| Piper packages / Piper 包 | `.local-env/packages` | `.local-env/packages` |
| FFmpeg | `.local-env/ffmpeg/bin/ffmpeg.exe` | `.local-env/ffmpeg/bin/ffmpeg` |
| FFprobe | `.local-env/ffmpeg/bin/ffprobe.exe` | `.local-env/ffmpeg/bin/ffprobe` |
| Installer / 安装器 | `set_local_env.cmd` → `tools/set_local_env.ps1` | `sh set_local_env.sh` |
| Marker / 标记 | `.local-env/install.json` with `windows-x86_64` | `.local-env/install.json` with `linux-x86_64` |

`server/onnx-runtime.js` chooses these paths from `process.platform`. When a required default component is missing, Windows starts the CMD installer through `ComSpec`; Linux starts the shell installer through `sh`. Unsupported operating systems fail before a child installer is launched.

`server/onnx-runtime.js` 根据 `process.platform` 选择上述路径。缺少默认组件时，Windows 通过 `ComSpec` 启动 CMD 安装器，Linux 通过 `sh` 启动 shell 安装器；不支持的操作系统会在启动子安装器前失败。

## Cross-platform conflict guard / 跨平台冲突保护

The Windows launcher and PowerShell installer detect `python/bin/python3` or a `linux-*` marker. The Linux launcher and shell installer detect `python.exe` or a `windows-*` marker. Detection is read-only.

Windows 启动器和 PowerShell 安装器会检测 `python/bin/python3` 或 `linux-*` 标记；Linux 启动器和 shell 安装器会检测 `python.exe` 或 `windows-*` 标记。检测过程只读。

A conflicting runtime is never deleted, repaired, or replaced automatically. Startup, `-status`, and `-install` stop with exit code 2 and tell the user to run the current platform's `-clear` action manually. The explicitly requested `-clear` action remains available and validates that its target is exactly the project's `.local-env` before recursive removal.

发现冲突运行时时，程序绝不会自动删除、修复或替换。启动、`-status` 和 `-install` 会以退出码 2 停止，并提示用户在当前平台手动执行 `-clear`。用户明确请求的 `-clear` 仍然可用，并会在递归删除前验证目标恰好是当前项目的 `.local-env`。

## Dependency pins and integrity / 依赖固定与完整性

Runtime artifacts use fixed versions, exact URLs, and SHA-256 values. Cached artifacts are reused only after hash verification. Python wheels are installed offline with `pip --no-index --find-links` after every manifest item has been downloaded and verified.

运行时资产使用固定版本、精确 URL 和 SHA-256。缓存资产只有在哈希验证通过后才会复用；清单中的所有 Python wheel 下载并校验完成后，才使用 `pip --no-index --find-links` 离线安装。

| Component / 组件 | Version and source / 版本与来源 |
| --- | --- |
| CPython / Windows | 3.10.20, `python-build-standalone` 20260718 Windows x86_64 |
| CPython / Linux | 3.10.20, `python-build-standalone` 20260718 Linux x86_64 GNU |
| Piper | 1.5.0 |
| ONNX Runtime | 1.23.2 |
| NumPy | 2.2.6 |
| FFmpeg / Windows | 8.1.2 gyan.dev essentials, GPLv3 |
| FFmpeg / Linux | 6.1.1 eugeneware static binaries, GPLv3 |

Windows wheel pins are stored in `tools/local-runtime-requirements.txt` and `tools/local-runtime-wheels.json`. Linux pins are separate in `tools/local-runtime-requirements-linux.txt` and `tools/local-runtime-wheels-linux.json`; the Linux list omits Windows-only `pyreadline3` and uses manylinux native wheels.

Windows wheel 固定信息位于 `tools/local-runtime-requirements.txt` 与 `tools/local-runtime-wheels.json`。Linux 使用独立的 `tools/local-runtime-requirements-linux.txt` 与 `tools/local-runtime-wheels-linux.json`；Linux 清单不包含 Windows 专用的 `pyreadline3`，并使用 manylinux 原生 wheel。

The Linux installer uses Node's built-in `fetch`, streams, and crypto through `tools/download_runtime_asset.mjs`, so curl, wget, system Python, and a package manager are not installer dependencies. Standalone Python, native wheels, FFmpeg, FFprobe, and the FFmpeg license are all placed under `.local-env`; only normal operating-system shell/file utilities and `tar` are used outside Node.js.

Linux 安装器通过 `tools/download_runtime_asset.mjs` 使用 Node 内置的 `fetch`、流与加密模块，因此不依赖 curl、wget、系统 Python 或包管理器。独立 Python、原生 wheels、FFmpeg、FFprobe 和 FFmpeg 许可证都放在 `.local-env` 下；Node.js 之外只使用操作系统常规 shell/文件工具与 `tar`。

## Python isolation / Python 隔离

Python synthesis runs with `-I -S`. Before every managed Python invocation, `PYTHONHOME`, `PYTHONPATH`, Conda variables, and Conda command modifiers are removed from the child environment, while `PYTHONNOUSERSITE=1` is set. `tools/synthesize_piper.py` inserts exactly the selected `.local-env/packages` directory into `sys.path` before importing Piper.

Python 合成使用 `-I -S`。每次调用受管 Python 前，都会从子进程环境中移除 `PYTHONHOME`、`PYTHONPATH`、Conda 变量和 Conda 命令修饰变量，并设置 `PYTHONNOUSERSITE=1`。`tools/synthesize_piper.py` 在导入 Piper 前，只把选定的 `.local-env/packages` 显式加入 `sys.path`。

The installer import-checks Piper, NumPy, and ONNX Runtime before marking Python ready. FFmpeg startup and `libmp3lame` availability are also checked before the complete runtime marker is written.

安装器会在把 Python 标记为就绪前导入检查 Piper、NumPy 和 ONNX Runtime；写入完整运行时标记前，还会检查 FFmpeg 能否启动以及是否包含 `libmp3lame`。

## Synthesis flow / 合成流程

`prepareJob` validates transcript length, model identity, format, speed, silence, volume, and speaker bounds on the main thread. `Intl.Segmenter` creates a multilingual sentence list before the request enters the scheduler; a punctuation-based fallback is retained for runtimes without `Intl.Segmenter`.

`prepareJob` 在主线程验证文本长度、模型身份、格式、语速、静音、音量和说话人范围。请求进入调度器前由 `Intl.Segmenter` 生成多语言句子列表；若运行时没有 `Intl.Segmenter`，则使用基于标点的后备分句。

The Python bridge verifies the matching `.onnx.json`, loads the selected Piper voice once, and synthesizes the supplied sentences separately. It records each start and end from the actual signed 16-bit PCM frame count, inserts zero-valued PCM between sentences, and returns the timing list in its final JSON line. Partial WAV files are removed after exceptions.

Python 桥接脚本会验证匹配的 `.onnx.json`，只加载一次所选 Piper 语音，再逐句合成传入的句子。每句起止时间按实际有符号 16 位 PCM 帧数记录，句间写入零值 PCM，最后一行 JSON 返回完整时间列表；发生异常时会删除不完整 WAV。

`BoundedFifoQueue` starts up to a CPU-derived number of jobs concurrently, capped at four by default, and keeps a finite first-in, first-out waiting list. Every running job owns a fresh Node worker thread, isolated temporary inputs, Python process, and optional project-local FFmpeg process. A full queue rejects immediately with HTTP 429 and the shared overload message. MP3 responses retain the WAV-derived timings; encoder delay can cause only a small playback-level offset.

`BoundedFifoQueue` 最多并行启动按 CPU 推断的任务数，默认不超过四个，并维护容量有限的先进先出等待列表。每个运行任务都有新的 Node worker thread、隔离的临时输入、Python 进程以及可选的项目内 FFmpeg 进程。队列满时立即以 HTTP 429 和统一过载提示拒绝。MP3 响应沿用 WAV 计算出的时间戳；编码器延迟只可能带来很小的播放层偏差。

## Model handling / 模型处理

Model discovery is rooted at `data/models`; custom uploads use `data/models/custom`. A voice is accepted only when `.onnx` and `.onnx.json` share a basename and the configuration parses successfully. Internal filesystem paths remain private and are removed from API model objects.

模型发现范围固定在 `data/models`；自定义上传使用 `data/models/custom`。只有同名的 `.onnx` 与 `.onnx.json` 且配置可成功解析时，语音才会被接受。内部文件系统路径保持私有，并从 API 模型对象中移除。

Hugging Face input accepts repository, tree, blob, and resolve URLs but restricts network origins to `https://huggingface.co`. Inspection does not recursively scan an entire multi-model repository. Downloads first use UUID `.part-*` files and are renamed only after validation; a supplied request token is not persisted.

Hugging Face 输入支持 repository、tree、blob 与 resolve URL，但网络来源限制为 `https://huggingface.co`。检查不会递归扫描完整的多模型仓库。下载先写入 UUID `.part-*` 文件，验证通过后才重命名；请求中提供的 token 不会持久化。

## HTTP interface / HTTP 接口

| Method / 方法 | Path / 路径 | Purpose / 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | Service and runtime readiness / 服务与运行时就绪状态 |
| `GET` | `/api/models` | Public model list / 公开模型列表 |
| `POST` | `/api/models/inspect` | Inspect a Hugging Face model pair / 检查 Hugging Face 模型对 |
| `POST` | `/api/models/download` | Download one selected pair / 下载一组已选择模型 |
| `POST` | `/api/models/upload` | Upload custom ONNX and JSON / 上传自定义 ONNX 与 JSON |
| `POST` | `/api/generate` | Generate audio plus sentence `text`/`start`/`end` timings / 生成音频及句子 `text`/`start`/`end` 时间 |
| `GET` | `/media/{file}` | Inline audio response / 内联音频响应 |
| `GET` | `/api/download/{file}` | Attachment audio response / 附件音频响应 |

The transport layer applies CSP, `X-Content-Type-Options`, and related headers, bounds JSON and multipart bodies, maps expected request errors to HTTP status codes, and prevents path traversal for public and audio files. Generated preview audio advertises byte ranges, returns 206 for one satisfiable range, and returns 416 with the complete size for invalid or multipart ranges so browser seeking remains reliable.

传输层设置 CSP、`X-Content-Type-Options` 等响应头，限制 JSON 与 multipart 请求体大小，把预期请求错误映射为 HTTP 状态码，并阻止 public 与音频文件的路径越界。生成的预览音频会声明字节范围支持：单个有效范围返回 206，无效或 multipart 范围返回 416 并附完整大小，从而保证浏览器跳转可靠。

Remote model files are limited to 2 GB, custom ONNX uploads to 1 GB, configuration JSON to 5 MB, and transcripts to 50,000 characters. The default bind address is `127.0.0.1`.

远程模型文件上限为 2 GB，自定义 ONNX 上传上限为 1 GB，配置 JSON 上限为 5 MB，文本上限为 50,000 字符。默认监听地址为 `127.0.0.1`。

## Frontend state / 前端状态

Theme preference is stored in LocalStorage as `onnxtts.theme` and restored by `public/theme.js` before the main stylesheet renders. The five recent voices use `onnxtts.recentVoices`. Neither value is sent to the server.

主题偏好以 `onnxtts.theme` 保存到 LocalStorage，并由 `public/theme.js` 在主样式渲染前恢复。最近五个语音使用 `onnxtts.recentVoices`；两项数据都不会发送到服务端。

The Voice Library groups ordinary models by language code and custom uploads under `custom`. The add menu owns the Hugging Face and custom-upload dialogs. Desktop and mobile layouts keep voice lists and dialogs internally scrollable rather than allowing page-width overflow.

Voice Library 按语言代码分组普通模型，并把自定义上传放在 `custom` 下。加号菜单负责 Hugging Face 与自定义上传对话框。桌面和移动布局让语音列表与对话框内部滚动，避免页面横向溢出。

The generated sentence buttons are built from the API timing list with text-only DOM operations. Playback uses `requestAnimationFrame` while audio is running and `timeupdate`/`seeked` fallbacks to update `aria-current` and the light highlight. Clicking a button seeks to its recorded start. A portrait-only media rule visually orders the editor before Voice Library without changing desktop DOM order.

生成后的句子按钮只通过文本 DOM 操作从 API 时间列表构建。音频播放时使用 `requestAnimationFrame`，并以 `timeupdate`/`seeked` 为后备来更新 `aria-current` 和浅色高亮；点击按钮会跳到记录的起点。仅竖屏生效的媒体规则会把编辑区排在 Voice Library 前面，不改变桌面的 DOM 顺序。

## Overrides and startup / 覆盖变量与启动

Port priority is `--port`/`-p`, then `ONNXTTS_PORT`, then `4317`. `ONNXTTS_HOST` defaults to `127.0.0.1`. The Windows launcher resolves Node from `PATH` and then scans standard `Program Files\nodejs` locations on drives C through F; the Linux launcher requires Node in `PATH`.

端口优先级依次为 `--port`/`-p`、`ONNXTTS_PORT`、`4317`。`ONNXTTS_HOST` 默认为 `127.0.0.1`。Windows 启动器先从 `PATH` 解析 Node，再扫描 C 到 F 盘的标准 `Program Files\nodejs` 路径；Linux 启动器要求 Node 位于 `PATH`。

The `-open` and `--open` flags take priority over `ONNXTTS_HOST` and force the bind address to `0.0.0.0`. In that mode `/api/health` reports `localOnly: false`; the application does not add authentication, TLS, or firewall rules.

`-open` 与 `--open` 的优先级高于 `ONNXTTS_HOST`，会强制把监听地址设为 `0.0.0.0`。此模式下 `/api/health` 返回 `localOnly: false`；应用不会自动增加身份验证、TLS 或防火墙规则。

`ONNXTTS_PYTHON`, `ONNXTTS_PIPER_RUNTIME`, and `ONNXTTS_FFMPEG` override managed paths for advanced debugging. The default runtime is considered required only for components without an override, but platform launchers still reject a visibly conflicting `.local-env` to prevent accidental reuse.

`ONNXTTS_PYTHON`、`ONNXTTS_PIPER_RUNTIME` 与 `ONNXTTS_FFMPEG` 可用于高级调试并覆盖受管路径。只有未被覆盖的组件才要求默认运行时就绪，但平台启动器仍会拒绝明显冲突的 `.local-env`，以防误用。

`ONNXTTS_SYNTHESIS_WORKERS` overrides the CPU-derived concurrency from 1 through 32. `ONNXTTS_SYNTHESIS_QUEUE_LIMIT` overrides the number of waiting jobs from 1 through 1000. Invalid values are ignored with a startup warning. `/api/health` exposes CPU parallelism and the current worker, active, queued, and limit values under `runtime.queue`.

`ONNXTTS_SYNTHESIS_WORKERS` 可把按 CPU 推断的并发数覆盖为 1 到 32；`ONNXTTS_SYNTHESIS_QUEUE_LIMIT` 可把等待任务数覆盖为 1 到 1000。无效值会被忽略，并在启动时给出警告。`/api/health` 会在 `runtime.queue` 下公开 CPU 并行度以及当前 worker、运行中、等待中和上限数值。

## Queue debug paths / 队列调试入口

The scheduler can be tested without HTTP, Piper, a model, or audio generation. This command uses fake timed jobs to assert FIFO start order, the concurrency ceiling, the waiting limit, and the exact HTTP-facing overload error:

调度器可以脱离 HTTP、Piper、模型和音频生成独立测试。下面的命令使用带假延迟的任务，断言 FIFO 启动顺序、并发上限、等待上限以及对 HTTP 暴露的准确过载错误：

```powershell
node tools\debug_synthesis_queue.mjs
```

The queue-full interface can be tested independently of synthesis by opening `http://127.0.0.1:4317/?queueDebug=full`. This explicit query mode supplies one fake voice and makes Generate return the same delayed 429 message entirely in the browser; URLs without the query use the real API.

满队列界面可以脱离合成独立测试：打开 `http://127.0.0.1:4317/?queueDebug=full`。这一显式查询模式会提供一个假语音，并让 Generate 完全在浏览器内延迟返回相同的 429 提示；不带该查询参数的 URL 仍使用真实 API。

## Maintenance checks / 维护检查

Run the following on Windows after relevant changes:

相关修改后，请在 Windows 执行：

```powershell
.\set_local_env.cmd -status
node --check server.mjs
node --check server\web.js
node --check server\onnx-runtime.js
node --check server\bounded-fifo-queue.js
node --check server\synthesis-worker.js
node --check public\app.js
node --check public\theme.js
node --check tools\download_runtime_asset.mjs
node tools\debug_synthesis_queue.mjs
& '.\.local-env\python\python.exe' -I -m py_compile tools\synthesize_piper.py
```

Run the following on Linux after relevant changes:

相关修改后，请在 Linux 执行：

```sh
sh -n set_local_env.sh
sh -n start_onnxtts.sh
sh ./set_local_env.sh -status
node --check server.mjs
node --check server/web.js
node --check server/onnx-runtime.js
node --check server/bounded-fifo-queue.js
node --check server/synthesis-worker.js
node --check tools/download_runtime_asset.mjs
node tools/debug_synthesis_queue.mjs
.local-env/python/bin/python3 -I -m py_compile tools/synthesize_piper.py
```

An end-to-end smoke test should start on a non-default port, inspect `runtime.queue` from `/api/health`, check `/api/models`, generate a multi-sentence WAV and MP3, verify monotonic timings, validate MP3 with project-local FFprobe, and stop the server cleanly. Browser QA should cover portrait ordering, sentence highlighting and seeking, the queue-full debug mode, desktop/mobile widths, dialogs, theme restoration, and console errors.

端到端烟雾测试应使用非默认端口启动，从 `/api/health` 检查 `runtime.queue`，检查 `/api/models`，真实生成多句 WAV 和 MP3，验证时间戳单调递增，再用项目内 FFprobe 校验 MP3，并正常停止服务。浏览器 QA 应覆盖竖屏顺序、句子高亮与跳转、满队列调试模式、桌面/移动宽度、对话框、主题恢复和控制台错误。

## Known constraints and licensing / 已知限制与许可

The bundled installers currently target Windows x64 and Linux x86_64. Only Piper-compatible ONNX voices are supported. The synthesis queue has no position/progress stream, cancellation, or active-worker termination during graceful shutdown. Hugging Face inspection is deliberately non-recursive; generated audio has no retention policy; `/media` supports one byte range per request but not multipart ranges.

内置安装器目前面向 Windows x64 与 Linux x86_64。只支持 Piper 兼容 ONNX 语音。合成队列不提供排位/进度流、取消，也不会在优雅关闭时主动终止正在运行的 worker。Hugging Face 检查有意不递归；生成音频没有保留策略；`/media` 每次请求支持一个字节范围，但不支持 multipart ranges。

Piper is GPL-3.0-or-later. The selected Windows and Linux FFmpeg builds are GPLv3 builds. Model licenses vary by model card. Any redistribution must preserve the applicable notices and satisfy the licenses for bundled binaries and models.

Piper 使用 GPL-3.0-or-later。当前选择的 Windows 与 Linux FFmpeg 均为 GPLv3 构建。模型许可取决于各自模型卡；任何再分发都必须保留适用声明，并满足所捆绑二进制与模型的许可要求。
