"""Offline voice-session transcription worker.

The worker reads local WAV files from a short-lived manifest and writes exactly
one JSON document to stdout.  Audio, transcript text, Discord identifiers, and
filesystem paths are never logged or sent to an external service.
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import os
from pathlib import Path
import sys
import sysconfig
from typing import Any


MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_SEGMENTS = 100_000
_NVIDIA_DLL_HANDLES: list[Any] = []


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


def _activate_local_nvidia_dlls() -> None:
    """Expose NVIDIA wheels installed in this virtual environment to Windows.

    Python 3.8+ no longer searches PATH alone for all dependent DLLs loaded by
    extension modules.  Keep the returned handles alive for the worker's whole
    process lifetime so CTranslate2 can load cuBLAS/cuDNN lazily on its first
    inference without requiring a machine-wide CUDA installation.
    """
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return

    purelib = Path(sysconfig.get_path("purelib"))
    candidates = (
        purelib / "nvidia" / "cublas" / "bin",
        purelib / "nvidia" / "cudnn" / "bin",
        purelib / "nvidia" / "cuda_runtime" / "bin",
    )
    active = {str(path).casefold() for path in candidates if path.is_dir()}
    if not active:
        return

    current_path = os.environ.get("PATH", "")
    path_parts = [part for part in current_path.split(os.pathsep) if part]
    existing = {part.casefold() for part in path_parts}
    for directory in candidates:
        if not directory.is_dir():
            continue
        rendered = str(directory)
        if rendered.casefold() not in existing:
            path_parts.insert(0, rendered)
            existing.add(rendered.casefold())
        try:
            _NVIDIA_DLL_HANDLES.append(os.add_dll_directory(rendered))
        except OSError:
            # A broken or inaccessible wheel directory must not weaken the
            # worker boundary.  CUDA inference will fail and use the narrowly
            # scoped CPU fallback below.
            continue
    os.environ["PATH"] = os.pathsep.join(path_parts)


def _load_model(model_name: str, device: str, compute_type: str):
    _activate_local_nvidia_dlls()
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise WorkerError("transcription runtime unavailable") from error

    kwargs: dict[str, Any] = {"device": device, "compute_type": compute_type}
    if _model_is_local(model_name):
        kwargs["local_files_only"] = True
        model_name = str(Path(model_name).expanduser().resolve(strict=True))
    return WhisperModel(model_name, **kwargs)


def _is_cuda_runtime_failure(error: Exception) -> bool:
    """Return true only for GPU runtime failures that are safe to retry on CPU."""
    message = str(error).lower()
    return isinstance(error, RuntimeError) and any(
        marker in message
        for marker in (
            "cublas",
            "cudnn",
            "cuda driver",
            "cuda runtime",
            "cuda_error",
            "out of memory",
        )
    )


def _is_cuda_initialization_failure(error: Exception) -> bool:
    """Recognize only expected local CUDA availability/runtime failures."""
    if _is_cuda_runtime_failure(error):
        return True
    message = str(error).lower()
    return isinstance(error, (RuntimeError, ValueError)) and "cuda" in message and any(
        marker in message
        for marker in (
            "not available",
            "no cuda",
            "no device",
            "device not found",
            "unsupported device",
        )
    )


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
        except Exception as error:
            # Model initialization failures are also safe to retry locally on
            # CPU because no segment inference has started yet.
            if isinstance(error, WorkerError) or not _is_cuda_initialization_failure(error):
                raise
            return _transcribe(_load_model(args.model, "cpu", "int8"), segments)
        try:
            return _transcribe(model, segments)
        except Exception as error:
            # CTranslate2 can finish model initialization before it loads
            # cuBLAS/cuDNN on the first inference.  Retry only recognized
            # CUDA runtime failures; malformed audio and other failures
            # remain fail-closed instead of being masked.
            if not _is_cuda_runtime_failure(error):
                raise
            del model
            gc.collect()
            return _transcribe(_load_model(args.model, "cpu", "int8"), segments)
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
