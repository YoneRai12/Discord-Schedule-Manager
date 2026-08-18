from __future__ import annotations

import argparse
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Download a faster-whisper model for offline runtime use")
    parser.add_argument("--repo", default="Systran/faster-whisper-large-v3")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    from huggingface_hub import snapshot_download

    output = Path(args.output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=args.repo,
        local_dir=str(output),
        allow_patterns=[
            "config.json",
            "model.bin",
            "preprocessor_config.json",
            "tokenizer.json",
            "vocabulary.*",
        ],
    )
    print("voice_model_ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
