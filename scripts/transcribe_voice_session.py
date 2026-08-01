"""Offline voice-session transcription worker.

The worker reads local WAV files from a short-lived manifest and writes exactly
one JSON document to stdout.  Audio, transcript text, Discord identifiers, and
filesystem paths are never logged or sent to an external service.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path
import sys
from typing import Any


MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_SEGMENTS = 100_000


class WorkerError(Exception):
    """Expected fail-closed worker error with no sensitive detail."""


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    return parser.parse_args()


def _safe_manifest_path(raw: str) -> Path:
    supplied = Path(raw)
    if supplied.is_symlink():
        raise WorkerError("invalid manifest")
    manifest = supplied.resolve(strict=True)
    if not manifest.is_file() or manifest.name != "manifest.json":
        raise WorkerError("invalid manifest")
    if manifest.stat().st_size > MAX_MANIFEST_BYTES:
        raise WorkerError("manifest too large")
    return manifest


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WorkerError("manifest unreadable") from error
    if not isinstance(parsed, dict) or parsed.get("version") != 1:
        raise WorkerError("invalid manifest")
    segments = parsed.get("segments")
    if not isinstance(segments, list) or not segments or len(segments) > MAX_SEGMENTS:
        raise WorkerError("invalid manifest segments")
    session_started_at_ms = parsed.get("sessionStartedAtMs")
    if (
        not isinstance(session_started_at_ms, (int, float))
        or isinstance(session_started_at_ms, bool)
        or session_started_at_ms < 0
    ):
        raise WorkerError("invalid session timestamp")

    workspace = path.parent
    checked: list[dict[str, Any]] = []
    for item in segments:
        if not isinstance(item, dict) or set(item) != {"speakerId", "speakerName", "startedAtMs", "wavPath"}:
            raise WorkerError("invalid manifest segment")
        supplied_wav = Path(item["wavPath"])
        if supplied_wav.is_symlink():
            raise WorkerError("invalid audio input")
        wav = supplied_wav.resolve(strict=True)
        try:
            wav.relative_to(workspace)
        except ValueError as error:
            raise WorkerError("audio outside workspace") from error
        if not wav.is_file() or wav.suffix.lower() != ".wav":
            raise WorkerError("invalid audio input")
        speaker_id = item["speakerId"]
        speaker_name = item["speakerName"]
        started_at_ms = item["startedAtMs"]
        if not isinstance(speaker_id, str) or len(speaker_id) > 256:
            raise WorkerError("invalid speaker")
        if not isinstance(speaker_name, str) or len(speaker_name) > 512:
            raise WorkerError("invalid speaker")
        if not isinstance(started_at_ms, (int, float)) or isinstance(started_at_ms, bool) or started_at_ms < 0:
            raise WorkerError("invalid timestamp")
        checked.append(
            {
                "speakerId": speaker_id,
                "speakerName": speaker_name,
                "startedAtMs": max(0.0, float(started_at_ms) - float(session_started_at_ms)),
                "wavPath": wav,
            }
        )
    return checked


def _model_is_local(model: str) -> bool:
    candidate = Path(model).expanduser()
    return candidate.exists()


def _load_model(model_name: str, device: str, compute_type: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise WorkerError("transcription runtime unavailable") from error

    kwargs: dict[str, Any] = {"device": device, "compute_type": compute_type}
    if _model_is_local(model_name):
        kwargs["local_files_only"] = True
        model_name = str(Path(model_name).expanduser().resolve(strict=True))
    return WhisperModel(model_name, **kwargs)


def _transcribe(model: Any, segments: list[dict[str, Any]]) -> dict[str, Any]:
    output: list[dict[str, Any]] = []
    for source in segments:
        generated, info = model.transcribe(
            str(source["wavPath"]),
            vad_filter=True,
            word_timestamps=False,
        )
        language = getattr(info, "language", None)
        if language is not None:
            language = str(language)[:32]
        for segment in generated:
            body = str(segment.text).strip()
            if not body:
                continue
            start_ms = source["startedAtMs"] + max(0.0, float(segment.start) * 1000.0)
            end_ms = source["startedAtMs"] + max(float(segment.start), float(segment.end)) * 1000.0
            output.append(
                {
                    "speakerId": source["speakerId"],
                    "speakerName": source["speakerName"],
                    "startMs": round(start_ms, 3),
                    "endMs": round(end_ms, 3),
                    "text": body,
                    "language": language,
                }
            )
    output.sort(key=lambda item: (item["startMs"], item["endMs"]))
    return {"version": 1, "segments": output}


def _run(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = _safe_manifest_path(args.manifest)
    segments = _load_manifest(manifest_path)

    if args.device in {"auto", "cuda"}:
        try:
            model = _load_model(args.model, "cuda", "float16")
        except Exception:
            # Only model initialization falls back.  Retrying an inference
            # failure could duplicate work and mask a corrupt local input.
            model = _load_model(args.model, "cpu", "int8")
        return _transcribe(model, segments)
    return _transcribe(_load_model(args.model, "cpu", "int8"), segments)


def main() -> int:
    logging.disable(logging.CRITICAL)
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    try:
        result = _run(_arguments())
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        sys.stdout.write("\n")
        return 0
    except Exception:
        # Never include exception text: it can contain paths, model names, IDs,
        # or transcript fragments supplied by a dependency.
        sys.stderr.write("local transcription failed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
