import { constants as fsConstants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { Writable } from "node:stream";

const WAV_HEADER_BYTES = 44;
const PCM_BITS_PER_SAMPLE = 16;
const REQUIRED_SAMPLE_RATE = 48_000;
const REQUIRED_CHANNELS = 2;

function wavHeader({ dataBytes, sampleRate, channels }) {
  const blockAlign = channels * (PCM_BITS_PER_SAMPLE / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export class WavSegmentWriter extends Writable {
  #filePath;
  #sampleRate;
  #channels;
  #fd;
  #dataBytes = 0;
  #closed = false;
  #aborted = false;

  constructor({ filePath, sampleRate = REQUIRED_SAMPLE_RATE, channels = REQUIRED_CHANNELS } = {}) {
    super({ decodeStrings: true, autoDestroy: true });
    if (!filePath) throw new TypeError("filePath is required");
    if (sampleRate !== REQUIRED_SAMPLE_RATE || channels !== REQUIRED_CHANNELS) {
      throw new RangeError("voice WAV must be 48000 Hz stereo PCM");
    }
    this.#filePath = String(filePath);
    this.#sampleRate = sampleRate;
    this.#channels = channels;

    let flags = fsConstants.O_RDWR | fsConstants.O_CREAT;
    try {
      const stats = lstatSync(this.#filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 0) {
        throw new Error("WAV part must be an empty regular file");
      }
    } catch (error) {
      if (error?.code === "ENOENT") flags |= fsConstants.O_EXCL;
      else throw error;
    }
    this.#fd = openSync(this.#filePath, flags, 0o600);
    const opened = fstatSync(this.#fd);
    if (!opened.isFile() || opened.size !== 0) {
      closeSync(this.#fd);
      this.#fd = undefined;
      throw new Error("WAV part must be an empty regular file");
    }
    writeSync(this.#fd, wavHeader({ dataBytes: 0, sampleRate, channels }), 0, WAV_HEADER_BYTES, 0);
  }

  get filePath() {
    return this.#filePath;
  }

  get dataBytes() {
    return this.#dataBytes;
  }

  _write(chunk, encoding, callback) {
    try {
      if (this.#closed || this.#aborted || this.#fd === undefined) throw new Error("WAV writer is closed");
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (this.#dataBytes + data.length > 0xffffffff - 36) throw new RangeError("WAV segment exceeds RIFF size limit");
      let offset = 0;
      while (offset < data.length) {
        offset += writeSync(this.#fd, data, offset, data.length - offset, WAV_HEADER_BYTES + this.#dataBytes + offset);
      }
      this.#dataBytes += data.length;
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    try {
      const frameBytes = this.#channels * (PCM_BITS_PER_SAMPLE / 8);
      if (this.#dataBytes % frameBytes !== 0) {
        throw new Error("PCM data does not end on a complete stereo signed-16 frame");
      }
      writeSync(
        this.#fd,
        wavHeader({ dataBytes: this.#dataBytes, sampleRate: this.#sampleRate, channels: this.#channels }),
        0,
        WAV_HEADER_BYTES,
        0,
      );
      fsyncSync(this.#fd);
      this.#closeFd();
      callback();
    } catch (error) {
      this.#closeFd();
      callback(error);
    }
  }

  _destroy(error, callback) {
    this.#closeFd();
    callback(error);
  }

  end(chunk, encoding, callback) {
    let finalChunk = chunk;
    let finalEncoding = encoding;
    let finalCallback = callback;
    if (typeof finalChunk === "function") {
      finalCallback = finalChunk;
      finalChunk = undefined;
      finalEncoding = undefined;
    } else if (typeof finalEncoding === "function") {
      finalCallback = finalEncoding;
      finalEncoding = undefined;
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.off("finish", onFinish);
        this.off("error", onError);
      };
      const onFinish = () => {
        cleanup();
        finalCallback?.();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      this.once("finish", onFinish);
      this.once("error", onError);
      super.end(finalChunk, finalEncoding);
    });
  }

  abort() {
    if (this.#aborted) return;
    this.#aborted = true;
    this.destroy();
    try {
      unlinkSync(this.#filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  #closeFd() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#fd !== undefined) {
      closeSync(this.#fd);
      this.#fd = undefined;
    }
  }
}

export const VOICE_WAV_FORMAT = Object.freeze({
  sampleRate: REQUIRED_SAMPLE_RATE,
  channels: REQUIRED_CHANNELS,
  bitsPerSample: PCM_BITS_PER_SAMPLE,
  encoding: "signed-integer-little-endian",
});
