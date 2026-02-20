const MAGIC = Buffer.from('AGTA', 'ascii')
const VERSION = 1

export type SipAudioFrame = {
  callId: string
  audioPcm16le: Buffer
}

export function encodeSipAudioFrame(
  callId: string,
  audioPcm16le: Buffer,
): Buffer {
  const callIdBytes = Buffer.from(callId, 'utf8')
  if (callIdBytes.length > 0xffff) {
    throw new Error('callId too long')
  }

  const header = Buffer.alloc(4 + 1 + 2)
  MAGIC.copy(header, 0)
  header.writeUInt8(VERSION, 4)
  header.writeUInt16LE(callIdBytes.length, 5)

  return Buffer.concat([header, callIdBytes, audioPcm16le])
}

export function decodeSipAudioFrame(buf: Buffer): SipAudioFrame | null {
  if (buf.length < 7) return null
  if (!buf.subarray(0, 4).equals(MAGIC)) return null

  const version = buf.readUInt8(4)
  if (version !== VERSION) return null

  const callIdLen = buf.readUInt16LE(5)
  const callIdStart = 7
  const callIdEnd = callIdStart + callIdLen
  if (callIdEnd > buf.length) return null

  const callId = buf.subarray(callIdStart, callIdEnd).toString('utf8')
  const audioPcm16le = buf.subarray(callIdEnd)
  return { callId, audioPcm16le }
}
