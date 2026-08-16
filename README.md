# ONNXTTS Local Voice Studio

ONNXTTS is a local web app for turning pasted transcripts into WAV or MP3 audio with Piper-compatible ONNX voices. It uses Node's standard library for the web server plus project-local Python/Piper and FFmpeg runtimes. FFmpeg is used for MP3 conversion. No `npm install` is required.

## Start

Double-click `start_onnxtts.cmd`, or run:

```powershell
& 'D:\Program Files\nodejs\node.exe' server.mjs
```

To use another local port, pass `--port` (or `-p`) to either entry point:

```powershell
.\start_onnxtts.cmd --port 5000
& 'D:\Program Files\nodejs\node.exe' server.mjs --port 5000
```

The command script uses `node.exe` from `PATH` when available. If the calling shell has a different `PATH` (as can happen in PowerShell), it falls back to `D:\Program Files\nodejs\node.exe`. Press `Ctrl+C` to stop the server.

Then open the address printed by the server (default: <http://127.0.0.1:4317>).

On first launch, the server runs `set_local_env.cmd -install` automatically. The installer downloads CPython 3.10.20, pinned Piper wheels, and the FFmpeg 8.1.2 Windows x64 essentials build under `.local-env`. Every archive and wheel is pinned and SHA-256-verified. This directory is ignored by Git and does not use or modify system Python, Conda, or system FFmpeg.

The local runtime can also be managed manually:

~~~cmd
set_local_env.cmd -status
set_local_env.cmd -install
set_local_env.cmd -clear
~~~

`-clear` removes only `ONNXTTS\\.local-env`. The next server launch installs it again.

Python synthesis runs with isolated interpreter flags and clears `PYTHONHOME`, `PYTHONPATH`, and Conda-specific environment variables. FFmpeg is installed from the GPLv3 gyan.dev essentials build linked by the official FFmpeg download page. All default runtime paths are calculated relative to `server.mjs`.

The server binds only to `127.0.0.1` by default. Transcript text is sent only to this local server. Network access is used solely when the user asks the app to inspect or download a Hugging Face model.

## Voice format

Version 0.1 supports **Piper-compatible ONNX voices** consisting of:

- `voice-name.onnx`
- `voice-name.onnx.json`
- optional `MODEL_CARD`

Paste either a Hugging Face folder URL containing one matching pair, or a direct `.onnx`/`.onnx.json` URL. Repository-root URLs with several voices are intentionally rejected so the choice is unambiguous. Private or gated repositories can use a read token in the installer; the token is submitted for that request only and is never written to disk.

General ONNX TTS files are not interchangeable: architectures can require different tokenisers, input tensors, phonemisers, speakers, or separate vocoders. Supporting another family therefore requires an adapter rather than merely loading its `.onnx` file.

## Existing voices

The app discovers voices installed in:

- `ONNXTTS/data/models`
- custom uploads in `ONNXTTS/data/models/custom`

Generated audio is stored in `ONNXTTS/data/audio`.

## Optional environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `ONNXTTS_PORT` | Local HTTP port (overridden by `--port`/`-p`) | `4317` |
| `ONNXTTS_HOST` | Bind address | `127.0.0.1` |
| `ONNXTTS_PYTHON` | Optional custom Python interpreter | `.local-env/python/python.exe` |
| `ONNXTTS_PIPER_RUNTIME` | Optional custom Piper package folder | `.local-env/packages` |
| `ONNXTTS_FFMPEG` | Optional custom FFmpeg executable or command | `.local-env/ffmpeg/bin/ffmpeg.exe` |
| `HF_TOKEN` | Optional Hugging Face read token | unset |

## API

- `GET /api/health` — local runtime and model status
- `GET /api/models` — discovered Piper voices
- `POST /api/models/inspect` — inspect a Hugging Face URL
- `POST /api/models/download` — download one compatible voice
- `POST /api/models/upload` — upload one Piper `.onnx` and matching JSON configuration as multipart form data
- `POST /api/generate` — synthesize a transcript

Downloads are restricted to `https://huggingface.co`, custom uploads are restricted to 1 GB with a 5 MB JSON limit, transcript requests are restricted to 50,000 characters, and only one synthesis job runs at a time.
