export function upsample8kTo16kLinear(pcm8kS16le: Buffer): Buffer {
  // Linear interpolation: output length = 2x samples
  const inSamples = pcm8kS16le.length / 2;
  if (inSamples < 2) return Buffer.from(pcm8kS16le);

  const out = Buffer.alloc(inSamples * 4); // 2x samples * 2 bytes

  let outOffset = 0;
  let prev = pcm8kS16le.readInt16LE(0);

  for (let i = 1; i < inSamples; i++) {
    const cur = pcm8kS16le.readInt16LE(i * 2);

    // write prev
    out.writeInt16LE(prev, outOffset);
    outOffset += 2;

    // interpolated sample between prev and cur
    const interp = (prev + cur) >> 1;
    out.writeInt16LE(interp, outOffset);
    outOffset += 2;

    prev = cur;
  }

  // last sample (and duplicate as simple hold)
  out.writeInt16LE(prev, outOffset);
  outOffset += 2;
  out.writeInt16LE(prev, outOffset);

  return out;
}

export function downsample16kTo8kPickEveryOther(pcm16kS16le: Buffer): Buffer {
  const inSamples = pcm16kS16le.length / 2;
  const outSamples = Math.floor(inSamples / 2);
  const out = Buffer.alloc(outSamples * 2);

  let o = 0;
  for (let i = 0; i + 1 < inSamples; i += 2) {
    const s = pcm16kS16le.readInt16LE(i * 2);
    out.writeInt16LE(s, o);
    o += 2;
  }
  return out;
}
