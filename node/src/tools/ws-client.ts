import WebSocket from 'ws'
import { WavWriter } from '../audio/wav.js'
import { generateSinePcm16le } from '../audio/tone.js'
import { decodeSipAudioFrame } from '../ws/protocol.js'

function env(name: string, def?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (def !== undefined) return def
    throw new Error(`Missing env var ${name}`)
  }
  return v
}

function envInt(name: string, def: number): number {
  const v = process.env[name]
  if (!v) return def
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : def
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (!v) return def
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

const cfg = {
  url: env('WS_URL', 'ws://127.0.0.1:3004'),
  recordSeconds: envInt('RECORD_SECONDS', 10),
  outFile: env(
    'OUT_WAV',
    `./ws-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`,
  ),
  sendBeep: envBool('SEND_BEEP', true),
  beepDelayMs: envInt('BEEP_DELAY_MS', 1500),
  beepDurationMs: envInt('BEEP_DURATION_MS', 800),
  beepHz: envInt('BEEP_HZ', 440),
  logEveryBytes: envInt('LOG_EVERY_BYTES', 32000),
}

console.log(`[ws-client] connecting ${cfg.url}`)
console.log(`[ws-client] recording ${cfg.recordSeconds}s to ${cfg.outFile}`)

const wavByCallId = new Map<string, WavWriter>()
let bytes = 0
let nextLog = cfg.logEveryBytes

const ws = new WebSocket(cfg.url)

ws.on('open', () => {
  console.log('[ws-client] connected')

  if (cfg.sendBeep) {
    setTimeout(() => {
      const pcm16k = generateSinePcm16le({
        frequencyHz: cfg.beepHz,
        durationMs: cfg.beepDurationMs,
        sampleRateHz: 8000,
        amplitude: 0.2,
      })

      console.log(
        `[ws-client] sending beep ${cfg.beepHz}Hz ${cfg.beepDurationMs}ms (${pcm16k.length} bytes)`,
      )

      // If we know a callId (from prior call-start JSON), we could frame this.
      // For now, send unframed; server routes it to the first active call.
      ws.send(pcm16k)
    }, cfg.beepDelayMs)
  }

  setTimeout(() => {
    console.log('[ws-client] done; closing')
    ws.close()
  }, cfg.recordSeconds * 1000)
})

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    console.log('[ws-client] text:', data.toString())
    return
  }

  const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)

  const decoded = decodeSipAudioFrame(b)
  const callId = decoded?.callId ?? 'unframed'
  const audio = decoded?.audioPcm16le ?? b

  let wav = wavByCallId.get(callId)
  if (!wav) {
    const suffix = callId === 'unframed' ? 'unframed' : callId
    const out = cfg.outFile.replace(/\.wav$/i, `-${suffix}.wav`)
    wav = new WavWriter(out, { sampleRateHz: 8000, channels: 1 })
    wavByCallId.set(callId, wav)
    console.log(`[ws-client] writing ${out}`)
  }

  wav.writePcm16le(audio)
  bytes += audio.length

  if (bytes >= nextLog) {
    console.log(`[ws-client] rx pcm bytes=${bytes}`)
    nextLog += cfg.logEveryBytes
  }
})

ws.on('close', () => {
  for (const w of wavByCallId.values()) w.close()
  console.log(`[ws-client] closed; wrote bytes=${bytes}`)
  if (bytes === 0) {
    console.log(
      '[ws-client] note: received 0 audio bytes. This is expected if no active call is bridged (no RTP flowing).',
    )
    console.log(
      '[ws-client] tip: place a call through Asterisk first, then re-run this client.',
    )
  }
  console.log(
    '[ws-client] tip: play with `ffplay -f s16le -ar 8000 -ac 1 <(tail -c +45 OUT_WAV)` or open the wav in an audio editor',
  )
})

ws.on('error', err => {
  console.error('[ws-client] error', err)
})
