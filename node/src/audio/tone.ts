export function generateSinePcm16le(opts: {
  frequencyHz: number;
  durationMs: number;
  sampleRateHz: number;
  amplitude?: number;
}): Buffer {
  const amplitude = opts.amplitude ?? 0.2;
  const totalSamples = Math.floor((opts.durationMs / 1000) * opts.sampleRateHz);
  const out = Buffer.alloc(totalSamples * 2);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / opts.sampleRateHz;
    const v = Math.sin(2 * Math.PI * opts.frequencyHz * t) * amplitude;
    const s = Math.max(-1, Math.min(1, v));
    out.writeInt16LE(Math.floor(s * 32767), i * 2);
  }

  return out;
}
