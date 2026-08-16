"""Render text with a Piper-compatible ONNX voice.

This bridge keeps the local web server dependency-free while loading Piper from
the project-local runtime selected by the Node entry point. Node passes paths
and synthesis controls as arguments, then reads the final JSON line from stdout.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import wave


def parse_args() -> argparse.Namespace:
    """Describe the narrow command-line contract used by onnx-runtime.js."""

    parser = argparse.ArgumentParser(description="Synthesize a Piper ONNX voice")
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--length-scale", type=float, default=1.0)
    parser.add_argument("--sentence-silence", type=float, default=0.18)
    parser.add_argument("--volume", type=float, default=0.92)
    parser.add_argument("--speaker-id", type=int)
    return parser.parse_args()


def main() -> None:
    """Load one local voice, stream its sentence chunks, and write mono PCM."""

    args = parse_args()

    # Piper voices are valid only when ONNX and companion JSON share a basename.
    config_path = Path(f"{args.model}.json")
    if not args.model.is_file() or not config_path.is_file():
        raise FileNotFoundError("The selected voice requires matching .onnx and .onnx.json files")

    # Node starts Python with -I -S; this explicit path is the only package root.
    sys.path.insert(0, str(args.runtime.resolve()))
    from piper import PiperVoice, SynthesisConfig  # pylint: disable=import-outside-toplevel

    # Transcript text arrives through a temporary UTF-8 file, never a shell arg.
    text = args.input.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Transcript is empty")

    voice = PiperVoice.load(args.model.resolve())
    synthesis_config = SynthesisConfig(
        speaker_id=args.speaker_id,
        length_scale=args.length_scale,
        noise_scale=0.667,
        noise_w_scale=0.8,
        normalize_audio=True,
        volume=args.volume,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)

    # Piper emits signed 16-bit mono chunks. Insert raw zero-valued PCM frames
    # between chunks so sentence spacing does not require a second audio tool.
    silence_frames = round(voice.config.sample_rate * args.sentence_silence)
    silence = bytes(silence_frames * 2)
    chunk_count = 0
    frame_count = 0

    try:
        with wave.open(str(args.output), "wb") as output:
            output.setframerate(voice.config.sample_rate)
            output.setsampwidth(2)
            output.setnchannels(1)
            for chunk in voice.synthesize(text, synthesis_config):
                if chunk_count:
                    output.writeframes(silence)
                    frame_count += silence_frames
                output.writeframes(chunk.audio_int16_bytes)
                frame_count += len(chunk.audio_int16_bytes) // 2
                chunk_count += 1
    except Exception:
        # Never leave a partial WAV that could be served as a successful result.
        args.output.unlink(missing_ok=True)
        raise

    if chunk_count == 0:
        args.output.unlink(missing_ok=True)
        raise RuntimeError("Piper produced no audio")

    # Keep this as the final stdout line: Node parses it as optional metadata.
    print(
        json.dumps(
            {
                "sampleRate": voice.config.sample_rate,
                "channels": 1,
                "bitsPerSample": 16,
                "duration": round(frame_count / voice.config.sample_rate, 3),
                "chunks": chunk_count,
            }
        )
    )


if __name__ == "__main__":
    main()