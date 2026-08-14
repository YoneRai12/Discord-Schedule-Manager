import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("voice Python dependencies are exactly pinned", async () => {
  const requirements = (await readFile(path.join(projectRoot, "requirements-voice.txt"), "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(requirements, [
    "faster-whisper==1.2.1",
    "ctranslate2==4.8.1",
  ]);
  const windowsCudaRequirements = (
    await readFile(path.join(projectRoot, "requirements-voice-cuda-windows.txt"), "utf8")
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(windowsCudaRequirements, [
    "nvidia-cublas-cu12==12.8.4.1",
    "nvidia-cuda-runtime-cu12==12.8.90",
    "nvidia-cudnn-cu12==9.8.0.87",
  ]);
});

test("Python worker keeps local models offline and falls back only for CUDA runtime failures", async () => {
  const worker = await readFile(path.join(projectRoot, "scripts", "transcribe_voice_session.py"), "utf8");
  assert.match(worker, /choices=\("auto", "cuda", "cpu"\)/u);
  assert.match(worker, /kwargs\["local_files_only"\] = True/u);
  assert.match(worker, /def _activate_local_nvidia_dlls\(\) -> None:/u);
  assert.match(worker, /os\.add_dll_directory\(rendered\)/u);
  assert.match(worker, /nvidia" \/ "cublas" \/ "bin/u);
  assert.match(worker, /def _is_cuda_runtime_failure\(error: Exception\) -> bool:/u);
  assert.match(worker, /def _is_cuda_initialization_failure\(error: Exception\) -> bool:/u);
  assert.match(worker, /"cublas"[\s\S]+"cudnn"[\s\S]+"cuda runtime"/u);
  assert.match(worker, /not _is_cuda_initialization_failure\(error\)/u);
  assert.match(worker, /if not _is_cuda_runtime_failure\(error\):[\s\S]+raise[\s\S]+return _transcribe\(_load_model\(args\.model, "cpu", "int8"\), segments\)/u);
  assert.match(worker, /del model[\s\S]+gc\.collect\(\)/u);
  assert.doesNotMatch(worker, /requests\.|urllib\.|httpx\.|aiohttp\.|socket\./u);
  assert.match(worker, /sys\.stderr\.write\("local transcription failed\\n"\)/u);
});

test("CUDA diagnostic uses only generated local audio", async () => {
  const diagnostic = await readFile(path.join(projectRoot, "scripts", "verify_voice_cuda.py"), "utf8");
  assert.match(diagnostic, /TemporaryDirectory\(prefix="voice-cuda-check-"\)/u);
  assert.match(diagnostic, /faster-whisper-large-v3/u);
  assert.match(diagnostic, /cuda_inference=ok/u);
  assert.doesNotMatch(diagnostic, /requests\.|urllib\.|httpx\.|aiohttp\.|socket\./u);
});

test("voice setup keeps CPU base dependencies separate from Windows CUDA wheels", async () => {
  const setup = await readFile(path.join(projectRoot, "scripts", "setup-local-voice.ps1"), "utf8");
  assert.match(setup, /\[ValidateSet\("cuda", "cpu"\)\]/u);
  assert.match(setup, /\$Device -eq "cuda"/u);
  assert.match(setup, /requirements-voice-cuda-windows\.txt/u);
  assert.match(setup, /MEETING_VOICE_STT_DEVICE=\$Device/u);
});

test("failed-session reprocessor reuses the production voice pipeline without logging identifiers", async () => {
  const reprocessor = await readFile(
    path.join(projectRoot, "scripts", "reprocess_failed_voice_session.mjs"),
    "utf8",
  );
  assert.match(reprocessor, /parsed\?\.version !== 1 \|\| !Array\.isArray\(parsed\.sessions\)/u);
  assert.match(reprocessor, /states\.includes\(entry\?\.state\)/u);
  assert.match(reprocessor, /reuseTranscript \? \["review_pending", "analysis_failed"\] : \["processing_failed"\]/u);
  assert.match(reprocessor, /new LocalTranscriber\(/u);
  assert.match(reprocessor, /new VoiceMinutesAnalyzer\(/u);
  assert.match(reprocessor, /new VoiceSummaryPublisher\(/u);
  assert.match(reprocessor, /await controller\.reprocess\(targetSessionId\)/u);
  assert.match(reprocessor, /await controller\.reanalyze\(targetSessionId\)/u);
  assert.doesNotMatch(reprocessor, /console\.(?:log|error)\([^\n]*(?:targetSessionId|started\.sessionId|discordToken)/u);
});
