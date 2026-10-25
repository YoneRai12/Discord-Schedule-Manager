"""Verify the local faster-whisper CUDA runtime with synthetic audio only."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import struct
import tempfile
import wave


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    worker_path = root / "scripts" / "transcribe_voice_session.py"
    spec = importlib.util.spec_from_file_location("voice_worker", worker_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("voice worker is unavailable")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)

    with tempfile.TemporaryDirectory(prefix="voice-cuda-check-") as temporary:
        wav_path = Path(temporary) / "sample.wav"
        sample_rate = 16_000
        with wave.open(str(wav_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(
                b"".join(
                    struct.pack("<h", int(9_000 * math.sin(2 * math.pi * 440 * index / sample_rate)))
                    for index in range(sample_rate)
                )
            )

        model = worker._load_model(
            str(root / "data" / "models" / "faster-whisper-large-v3"),
            "cuda",
            "float16",
        )
        generated, _ = model.transcribe(str(wav_path), vad_filter=True, word_timestamps=False)
        segment_count = sum(1 for _ in generated)
    print(f"cuda_inference=ok segments={segment_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
