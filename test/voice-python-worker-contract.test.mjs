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
});

test("Python worker keeps auto/CUDA fallback at model initialization and local models offline", async () => {
  const worker = await readFile(path.join(projectRoot, "scripts", "transcribe_voice_session.py"), "utf8");
  assert.match(worker, /choices=\("auto", "cuda", "cpu"\)/u);
  assert.match(worker, /kwargs\["local_files_only"\] = True/u);
  assert.match(worker, /model = _load_model\(args\.model, "cuda", "float16"\)[\s\S]+except Exception:[\s\S]+model = _load_model\(args\.model, "cpu", "int8"\)[\s\S]+return _transcribe\(model, segments\)/u);
  assert.doesNotMatch(worker, /requests\.|urllib\.|httpx\.|aiohttp\.|socket\./u);
  assert.match(worker, /sys\.stderr\.write\("local transcription failed\\n"\)/u);
});
