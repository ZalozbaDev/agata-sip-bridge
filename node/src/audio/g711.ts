// G.711 μ-law codec (PCMU)

const MULAW_MAX = 0x1FFF;
const BIAS = 0x84;

function linearToMuLawSample(sample: number): number {
  // sample: int16 range
  let sign = 0;
  let pcm = sample;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
    if (pcm > 32767) pcm = 32767;
  }

  pcm = pcm + BIAS;
  if (pcm > MULAW_MAX) pcm = MULAW_MAX;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0F;
  const ulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulaw;
}

function muLawToLinearSample(ulawByte: number): number {
  let ulaw = (~ulawByte) & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;

  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;

  return sign ? -sample : sample;
}

export function encodeMuLaw(pcm16le: Buffer): Buffer {
  const out = Buffer.alloc(pcm16le.length / 2);
  for (let i = 0, o = 0; i < pcm16le.length; i += 2, o++) {
    const s = pcm16le.readInt16LE(i);
    out[o] = linearToMuLawSample(s);
  }
  return out;
}

export function decodeMuLaw(muLaw: Buffer): Buffer {
  const out = Buffer.alloc(muLaw.length * 2);
  for (let i = 0, o = 0; i < muLaw.length; i++, o += 2) {
    const s = muLawToLinearSample(muLaw[i]);
    // clamp to int16
    const clamped = Math.max(-32768, Math.min(32767, s));
    out.writeInt16LE(clamped, o);
  }
  return out;
}
