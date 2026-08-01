import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import { VOICE_WAV_FORMAT, WavSegmentWriter } from "../src/voice/wav-segment-writer.mjs";

test("WAV writer emits a 48 kHz stereo signed-16 little-endian header", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-wav-"));
  const filePath = path.join(root, "segment.wav.part");
  const writer = new WavSegmentWriter({ filePath, sampleRate: 48_000, channels: 2 });
  const pcm = Buffer.from([0x01, 0x80, 0xff, 0x7f, 0x00, 0x00, 0x34, 0x12]);
  await writer.end(pcm);
  await finished(writer);

  const wav = await readFile(filePath);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48_000);
  assert.equal(wav.readUInt32LE(28), 192_000);
  assert.equal(wav.readUInt16LE(32), 4);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.deepEqual(VOICE_WAV_FORMAT, {
    sampleRate: 48_000,
    channels: 2,
    bitsPerSample: 16,
    encoding: "signed-integer-little-endian",
  });
});

test("WAV writer rejects non-contract formats and incomplete PCM frames", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-wav-invalid-"));
  assert.throws(
    () => new WavSegmentWriter({ filePath: path.join(root, "mono.part"), sampleRate: 48_000, channels: 1 }),
    /48000 Hz stereo/u,
  );
  const writer = new WavSegmentWriter({ filePath: path.join(root, "short.part") });
  await assert.rejects(writer.end(Buffer.alloc(3)), /complete stereo signed-16 frame/u);
});

test("abort closes and removes the plaintext part", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-wav-abort-"));
  const filePath = path.join(root, "segment.wav.part");
  const writer = new WavSegmentWriter({ filePath });
  writer.write(Buffer.alloc(4));
  writer.abort();
  await assert.rejects(stat(filePath), (error) => error?.code === "ENOENT");
});
