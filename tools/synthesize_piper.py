"""Render sentence-segmented text with a Piper-compatible ONNX voice.

Node supplies the exact sentence list so this bridge can synthesize each segment
separately and report frame-accurate sentence start/end times with the audio.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import wave


def parse_args() -> argparse.Namespace:
    """Describe the narrow command-line contract used by the synthesis worker."""

    parser = argparse.ArgumentParser(description="Synthesize a Piper ONNX voice")
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--sentences", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--length-scale", type=float, default=1.0)
    parser.add_argument("--sentence-silence", type=float, default=0.18)
    parser.add_argument("--volume", type=float, default=0.92)
    parser.add_argument("--speaker-id", type=int)
    return parser.parse_args()


def read_sentences(path: Path) -> list[str]:
    """Load and validate the Node-segmented sentence protocol."""

    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("Sentence input must be a JSON array")
    sentences = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    if not sentences or len(sentences) != len(value):
        raise ValueError("Sentence input contains an empty or invalid segment")
    return sentences


def main() -> None:
    """Load one voice, synthesize each sentence, and write mono PCM plus timings."""

    args = parse_args()

    config_path = Path(f"{args.model}.json")
    if not args.model.is_file() or not config_path.is_file():
        raise FileNotFoundError("The selected voice requires matching .onnx and .onnx.json files")

    sys.path.insert(0, str(args.runtime.resolve()))
    from piper import PiperVoice, SynthesisConfig  # pylint: disable=import-outside-toplevel

    text = args.input.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("Transcript is empty")
    sentences = read_sentences(args.sentences)

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
    sample_rate = voice.config.sample_rate
    silence_frames = round(sample_rate * args.sentence_silence)
    silence = bytes(silence_frames * 2)
    chunk_count = 0
    frame_count = 0
    sentence_timings: list[dict[str, object]] = []

    try:
        with wave.open(str(args.output), "wb") as output:
            output.setframerate(sample_rate)
            output.setsampwidth(2)
            output.setnchannels(1)
            for sentence_index, sentence in enumerate(sentences):
                if sentence_index:
                    output.writeframes(silence)
                    frame_count += silence_frames

                start_frame = frame_count
                sentence_chunks = 0
                for chunk in voice.synthesize(sentence, synthesis_config):
                    output.writeframes(chunk.audio_int16_bytes)
                    frame_count += len(chunk.audio_int16_bytes) // 2
                    chunk_count += 1
                    sentence_chunks += 1

                if sentence_chunks == 0:
                    raise RuntimeError(f"Piper produced no audio for sentence {sentence_index + 1}")
                sentence_timings.append(
                    {
                        "text": sentence,
                        "start": round(start_frame / sample_rate, 3),
                        "end": round(frame_count / sample_rate, 3),
                    }
                )
    except Exception:
        args.output.unlink(missing_ok=True)
        raise

    if chunk_count == 0:
        args.output.unlink(missing_ok=True)
        raise RuntimeError("Piper produced no audio")

    print(
        json.dumps(
            {
                "sampleRate": sample_rate,
                "channels": 1,
                "bitsPerSample": 16,
                "duration": round(frame_count / sample_rate, 3),
                "chunks": chunk_count,
                "sentences": sentence_timings,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
