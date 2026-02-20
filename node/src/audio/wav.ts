import fs from 'node:fs';
import path from 'node:path';

export class WavWriter {
  private fd: number;
  private bytesWritten = 0;

  constructor(
    private filePath: string,
    private opts: { sampleRateHz: number; channels: number }
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, 'w');
    // placeholder header
    fs.writeSync(this.fd, this.buildHeader(0));
  }

  writePcm16le(chunk: Buffer) {
    this.bytesWritten += chunk.length;
    fs.writeSync(this.fd, chunk);
  }

  close() {
    // rewrite header with final sizes
    const header = this.buildHeader(this.bytesWritten);
    fs.writeSync(this.fd, header, 0, header.length, 0);
    fs.closeSync(this.fd);
  }

  private buildHeader(dataBytes: number): Buffer {
    const { sampleRateHz, channels } = this.opts;
    const bitsPerSample = 16;
    const byteRate = sampleRateHz * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const riffChunkSize = 36 + dataBytes;

    const b = Buffer.alloc(44);
    b.write('RIFF', 0);
    b.writeUInt32LE(riffChunkSize, 4);
    b.write('WAVE', 8);
    b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); // PCM fmt chunk size
    b.writeUInt16LE(1, 20); // PCM
    b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(sampleRateHz, 24);
    b.writeUInt32LE(byteRate, 28);
    b.writeUInt16LE(blockAlign, 32);
    b.writeUInt16LE(bitsPerSample, 34);
    b.write('data', 36);
    b.writeUInt32LE(dataBytes, 40);
    return b;
  }
}
