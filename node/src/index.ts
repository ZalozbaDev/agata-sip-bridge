import { AriClient, type AriEvent } from './ari/ari.js'
import { RtpEndpoint } from './rtp/rtp.js'
import { WsHub } from './ws/ws.js'
import { decodeSipAudioFrame, encodeSipAudioFrame } from './ws/protocol.js'
import { decodeMuLaw, encodeMuLaw } from './audio/g711.js'
import { generateSinePcm16le } from './audio/tone.js'
import { WavWriter } from './audio/wav.js'

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
  if (!Number.isFinite(n)) return def
  return n
}

function envFloat(name: string, def: number): number {
  const v = process.env[name]
  if (!v) return def
  const n = Number.parseFloat(v)
  if (!Number.isFinite(n)) return def
  return n
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (!v) return def
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

const cfg = {
  ariUrl: env('ARI_URL', 'http://127.0.0.1:8088/ari'),
  ariUser: env('ARI_USER', 'ariuser'),
  ariPass: env('ARI_PASS', 'aripass'),
  ariApp: env('ARI_APP', 'sipws'),

  wsPort: envInt('WS_PORT', 3000),
  rtpPort: envInt('RTP_PORT', 5004),
  rtpCodec: env('RTP_CODEC', 'ulaw'),
  externalMediaHost: env('EXTERNAL_MEDIA_HOST', ''),

  sendTestBeep: envBool('SEND_TEST_BEEP', true),
  echoInbound: envBool('ECHO_INBOUND', false),
  dumpWav: envBool('DUMP_WAV', false),
  logRtpEveryN: envInt('LOG_RTP_EVERY_N', 200),

  // Simple VAD-style logging (logs speech start/end based on energy)
  logVad: envBool('LOG_VAD', true),
  vadThresholdDbfs: envFloat('VAD_THRESHOLD_DBFS', -45),
  vadHangoverMs: envInt('VAD_HANGOVER_MS', 600),

  // Extra diagnostics (kept lightweight on purpose)
  logAudioLevelEveryMs: envInt('LOG_AUDIO_LEVEL_EVERY_MS', 1000),
  warnIfNoRtpAfterMs: envInt('WARN_IF_NO_RTP_AFTER_MS', 2500),

  // If true, try to prime the RTP remote (Asterisk) from ARI channel variables.
  // This helps in setups where Asterisk doesn't send RTP until it receives RTP first.
  primeRtpFromAri: envBool('PRIME_RTP_FROM_ARI', true),
}

if (cfg.rtpCodec !== 'ulaw') {
  // eslint-disable-next-line no-console
  console.warn(
    `[WARN] RTP_CODEC=${cfg.rtpCodec} not implemented yet; using ulaw only.`,
  )
}

const wsHub = new WsHub(cfg.wsPort)
wsHub.onConnection(ws => {
  ws.send(
    JSON.stringify({
      type: 'hello',
      audio: { rate: 8000, channels: 1, format: 'pcm_s16le' },
      note: 'Binary WS messages are framed: MAGIC=AGTA, v=1, uint16le callIdLen, callId utf8, then PCM16LE@8k payload. Send framed binary back to inject audio for a specific call. Raw (unframed) PCM16LE@8k is still accepted but routes to the first active call.',
    }),
  )
})

// RTP payload type for PCMU is static 0
const rtp = new RtpEndpoint({
  port: cfg.rtpPort,
  logEveryN: cfg.logRtpEveryN,
  payloadType: 0,
})

const ari = new AriClient({
  ariUrl: cfg.ariUrl,
  user: cfg.ariUser,
  pass: cfg.ariPass,
  app: cfg.ariApp,
})

type CallState = {
  callId: string
  inboundChannelId: string
  bridgeId: string
  externalChannelId: string
  startedAt: number
  wav?: WavWriter
  beepTimer?: NodeJS.Timeout
  injectedBuffer: Buffer
  formatAnnounced: boolean

  rtpRemote?: { address: string; port: number }
  rtpRemoteKey?: string

  vadSpeechActive: boolean
  vadLastSpeechAt: number
  vadPacketCount: number
  vadMaxDbfs: number
  vadEverSpeech: boolean

  rtpFirstPacketAt: number
  rtpLastPacketAt: number
  rtpLastLevelDbfs: number
  audioNextLevelLogAt: number
}

const calls = new Map<string, CallState>()
const remoteKeyToCallId = new Map<string, string>()

function getOrCreateCallByInbound(inboundChannelId: string): CallState {
  const existing = calls.get(inboundChannelId)
  if (existing) return existing

  const bridgeId = `bridge-${inboundChannelId}`
  const externalChannelId = `ext-${inboundChannelId}`

  const cs: CallState = {
    callId: inboundChannelId,
    inboundChannelId,
    bridgeId,
    externalChannelId,
    startedAt: Date.now(),
    injectedBuffer: Buffer.alloc(0),
    formatAnnounced: false,

    rtpRemote: undefined,
    rtpRemoteKey: undefined,

    vadSpeechActive: false,
    vadLastSpeechAt: 0,
    vadPacketCount: 0,
    vadMaxDbfs: Number.NEGATIVE_INFINITY,
    vadEverSpeech: false,

    rtpFirstPacketAt: 0,
    rtpLastPacketAt: 0,
    rtpLastLevelDbfs: Number.NEGATIVE_INFINITY,
    audioNextLevelLogAt: 0,
  }
  calls.set(inboundChannelId, cs)
  return cs
}

function pcm16leRmsDbfs(pcm16le: Buffer): number {
  const samples = Math.floor(pcm16le.length / 2)
  if (samples <= 0) return Number.NEGATIVE_INFINITY

  let sumSq = 0
  for (let i = 0; i < samples; i++) {
    const s = pcm16le.readInt16LE(i * 2)
    sumSq += s * s
  }

  const meanSq = sumSq / samples
  const rms = Math.sqrt(meanSq) / 32768
  if (rms <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(rms)
}

function cleanupCall(inboundChannelId: string): void {
  const cs = calls.get(inboundChannelId)
  if (!cs) return

  const durationMs = Date.now() - cs.startedAt

  if (cs.beepTimer) clearInterval(cs.beepTimer)
  if (cs.wav) {
    try {
      cs.wav.close()
    } catch {
      // ignore
    }
  }

  calls.delete(inboundChannelId)
  if (cs.rtpRemoteKey) remoteKeyToCallId.delete(cs.rtpRemoteKey)

  if (cfg.logVad) {
    if (cs.vadSpeechActive) {
      // eslint-disable-next-line no-console
      console.log(`[VAD] speech end (call cleanup) inbound=${inboundChannelId}`)
    }

    // eslint-disable-next-line no-console
    console.log(
      `[VAD] summary inbound=${inboundChannelId} rtpPackets=${cs.vadPacketCount} maxLevel=${Number.isFinite(cs.vadMaxDbfs) ? cs.vadMaxDbfs.toFixed(1) + 'dBFS' : 'n/a'} speechDetected=${cs.vadEverSpeech ? 'yes' : 'no'}`,
    )
  }

  // eslint-disable-next-line no-console
  console.log(
    `[CALL] cleaned up inbound=${inboundChannelId} durationMs=${durationMs}`,
  )
}

function startBeepOnceRtpIsReady(cs: CallState): void {
  if (!cfg.sendTestBeep) return
  if (cs.beepTimer) return

  // Wait until we know the remote RTP endpoint.
  if (!cs.rtpRemote) {
    setTimeout(() => startBeepOnceRtpIsReady(cs), 200)
    return
  }

  const remote = cs.rtpRemote

  // 440Hz, 1s, 8kHz PCM -> μlaw, packetize 20ms
  const pcm8k = generateSinePcm16le({
    frequencyHz: 440,
    durationMs: 1000,
    sampleRateHz: 8000,
    amplitude: 0.2,
  })
  const ulaw = encodeMuLaw(pcm8k)

  const frameBytes = 160 // 20ms @ 8k
  let offset = 0

  // eslint-disable-next-line no-console
  console.log(`[BEEP] start 440Hz 1s inbound=${cs.inboundChannelId}`)

  cs.beepTimer = setInterval(() => {
    if (offset >= ulaw.length) {
      if (cs.beepTimer) clearInterval(cs.beepTimer)
      cs.beepTimer = undefined
      // eslint-disable-next-line no-console
      console.log(`[BEEP] done inbound=${cs.inboundChannelId}`)
      return
    }

    const frame = ulaw.subarray(offset, offset + frameBytes)
    offset += frameBytes

    // For PCMU: bytes == samples
    rtp.sendPayloadTo(remote, frame, frame.length)
  }, 20)
}

async function primeRtpRemoteFromAri(cs: CallState): Promise<void> {
  if (!cfg.primeRtpFromAri) return

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  // These are typical for UnicastRTP channels created by ARI externalMedia.
  const varsToTry = [
    'UNICASTRTP_LOCAL_ADDRESS',
    'UNICASTRTP_LOCAL_PORT',
    'CHANNEL(rtp,local_addr)',
    'CHANNEL(rtp,local_port)',
  ]

  let localAddr: string | undefined
  let localPort: number | undefined

  for (let attempt = 0; attempt < 30; attempt++) {
    const vAddr =
      (await ari.getChannelVar(
        cs.externalChannelId,
        'UNICASTRTP_LOCAL_ADDRESS',
      )) ??
      (await ari.getChannelVar(cs.externalChannelId, 'CHANNEL(rtp,local_addr)'))
    const vPort =
      (await ari.getChannelVar(
        cs.externalChannelId,
        'UNICASTRTP_LOCAL_PORT',
      )) ??
      (await ari.getChannelVar(cs.externalChannelId, 'CHANNEL(rtp,local_port)'))

    if (vAddr && !localAddr) localAddr = vAddr
    if (vPort && !localPort) {
      const p = Number.parseInt(vPort, 10)
      if (Number.isFinite(p) && p > 0 && p < 65536) localPort = p
    }

    if (localPort) break
    await sleep(100)
  }

  if (!localPort) {
    // eslint-disable-next-line no-console
    console.warn(
      `[RTP] could not read UnicastRTP local port from ARI ext=${cs.externalChannelId} tried=${varsToTry.join(',')}`,
    )
    return
  }

  // Some Asterisk builds may report 0.0.0.0; in Docker we can safely use the service name.
  const addr = !localAddr || localAddr === '0.0.0.0' ? 'asterisk' : localAddr

  cs.rtpRemote = { address: addr, port: localPort }
  cs.rtpRemoteKey = `${addr}:${localPort}`
  remoteKeyToCallId.set(cs.rtpRemoteKey, cs.callId)

  // Keep a default remote for single-call diagnostics.
  rtp.setRemote(cs.rtpRemote)
  // eslint-disable-next-line no-console
  console.log(
    `[RTP] primed remote from ARI ext=${cs.externalChannelId} inbound=${cs.inboundChannelId} -> ${addr}:${localPort}`,
  )
}

wsHub.onBinary(data => {
  // Inbound WS binary is either:
  // - framed (recommended): AGTA v1 + callId + PCM16LE 8k
  // - raw (legacy): PCM16LE 8k, routed to first active call

  const decoded = decodeSipAudioFrame(data)
  const cs = decoded ? calls.get(decoded.callId) : calls.values().next().value
  if (!cs) return

  const audio8k = decoded ? decoded.audioPcm16le : data
  cs.injectedBuffer = Buffer.concat([cs.injectedBuffer, audio8k])

  const frame8kBytes = 320 // 20ms @ 8kHz: 160 samples * 2 bytes
  while (cs.injectedBuffer.length >= frame8kBytes) {
    if (!cs.rtpRemote) return
    const frame8k = cs.injectedBuffer.subarray(0, frame8kBytes)
    cs.injectedBuffer = cs.injectedBuffer.subarray(frame8kBytes)

    const ulaw = encodeMuLaw(frame8k)

    rtp.sendPayloadTo(cs.rtpRemote, ulaw, ulaw.length)
  }
})

await rtp.start(pkt => {
  const remoteKey = `${pkt.remote.address}:${pkt.remote.port}`

  let callId = remoteKeyToCallId.get(remoteKey)
  if (!callId) {
    for (const c of calls.values()) {
      if (c.rtpRemoteKey === remoteKey) {
        callId = c.callId
        break
      }
    }

    // If only one call exists, bind it to this remote.
    if (!callId && calls.size === 1) {
      const only = calls.values().next().value as CallState
      callId = only.callId
      only.rtpRemote = pkt.remote
      only.rtpRemoteKey = remoteKey
      remoteKeyToCallId.set(remoteKey, callId)
      // eslint-disable-next-line no-console
      console.log(
        `[RTP] bound single call inbound=${callId} remote=${remoteKey}`,
      )
    }
  }

  if (!callId) {
    // eslint-disable-next-line no-console
    console.warn(
      `[RTP] could not route packet remote=${remoteKey} calls=${calls.size}`,
    )
    return
  }

  const cs = calls.get(callId)
  if (!cs) return
  if (!cs.rtpRemote) {
    cs.rtpRemote = pkt.remote
    cs.rtpRemoteKey = remoteKey
    remoteKeyToCallId.set(remoteKey, callId)
  }

  // Incoming payload is PCMU bytes @ 8k
  const pcm8k = decodeMuLaw(pkt.payload)

  // Track RTP presence + periodic level logs (even if below VAD threshold)
  const now = Date.now()
  const dbfs = pcm16leRmsDbfs(pcm8k)

  if (!cs.rtpFirstPacketAt) {
    cs.rtpFirstPacketAt = now
    cs.audioNextLevelLogAt = now
    // eslint-disable-next-line no-console
    console.log(
      `[RTP] first packet inbound=${cs.inboundChannelId} remote=${pkt.remote.address}:${pkt.remote.port} bytes=${pkt.payload.length} level=${Number.isFinite(dbfs) ? dbfs.toFixed(1) + 'dBFS' : 'n/a'}`,
    )
  }

  cs.rtpLastPacketAt = now
  cs.rtpLastLevelDbfs = dbfs

  if (
    cfg.logAudioLevelEveryMs > 0 &&
    now >= cs.audioNextLevelLogAt &&
    Number.isFinite(dbfs)
  ) {
    // eslint-disable-next-line no-console
    console.log(
      `[AUDIO] rx inbound=${cs.inboundChannelId} level=${dbfs.toFixed(1)}dBFS bytes=${pkt.payload.length} remote=${pkt.remote.address}:${pkt.remote.port}`,
    )
    cs.audioNextLevelLogAt = now + cfg.logAudioLevelEveryMs
  }

  if (cfg.logVad) {
    cs.vadPacketCount++
    if (dbfs > cs.vadMaxDbfs) cs.vadMaxDbfs = dbfs

    if (cs.vadPacketCount === 1) {
      // eslint-disable-next-line no-console
      console.log(
        `[VAD] first audio frame inbound=${cs.inboundChannelId} level=${Number.isFinite(dbfs) ? dbfs.toFixed(1) + 'dBFS' : 'n/a'} threshold=${cfg.vadThresholdDbfs}dBFS remote=${pkt.remote.address}:${pkt.remote.port}`,
      )
    }

    const isSpeech = dbfs >= cfg.vadThresholdDbfs
    if (isSpeech) {
      cs.vadLastSpeechAt = now
      cs.vadEverSpeech = true
    }

    if (!cs.vadSpeechActive && isSpeech) {
      cs.vadSpeechActive = true
      // eslint-disable-next-line no-console
      console.log(
        `[VAD] speech start inbound=${cs.inboundChannelId} level=${dbfs.toFixed(1)}dBFS remote=${pkt.remote.address}:${pkt.remote.port}`,
      )
    } else if (
      cs.vadSpeechActive &&
      cs.vadLastSpeechAt > 0 &&
      now - cs.vadLastSpeechAt > cfg.vadHangoverMs
    ) {
      cs.vadSpeechActive = false
      // eslint-disable-next-line no-console
      console.log(
        `[VAD] speech end inbound=${cs.inboundChannelId} remote=${pkt.remote.address}:${pkt.remote.port}`,
      )
    }
  }

  // Announce format once after first RTP
  if (!Array.from(calls.values()).some(c => c.formatAnnounced)) {
    wsHub.broadcastJson({
      type: 'audio-format',
      rate: 8000,
      channels: 1,
      format: 'pcm_s16le',
    })
    for (const c of calls.values()) c.formatAnnounced = true
  }

  wsHub.broadcastBinary(encodeSipAudioFrame(callId, pcm8k))

  // Optional wav dump: 16k PCM (per call)
  if (cfg.dumpWav) {
    if (!cs.wav) {
      const filePath = `/tmp/recordings/${cs.inboundChannelId}-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`
      cs.wav = new WavWriter(filePath, { sampleRateHz: 8000, channels: 1 })
      // eslint-disable-next-line no-console
      console.log(`[WAV] writing ${filePath}`)
    }
    cs.wav.writePcm16le(pcm8k)
  }

  if (cfg.echoInbound) {
    // Simple loopback: send back same PCMU payload
    rtp.sendPayloadTo(
      cs.rtpRemote ?? pkt.remote,
      pkt.payload,
      pkt.payload.length,
    )

    // eslint-disable-next-line no-console
    console.log(
      `[AUDIO] tx echo inbound=${cs.inboundChannelId} bytes=${pkt.payload.length}`,
    )
  }

  // TODO: VOSK STT
  // - stream `pcm16k` into Vosk recognizer
  // - emit partial/final results via wsHub.broadcastJson({type:'stt', ...})

  // TODO: TTS
  // - synthesize text to PCM16 16k
  // - inject via wsHub.onBinary or direct RTP injection pipeline

  // TODO: Business logic
  // - decide what to answer based on STT results
  // - manage per-call sessions and routing
})

// ARI handling
function isExternalChannelId(channelId: string): boolean {
  return channelId.startsWith('ext-')
}

function inboundIdFromExternal(channelId: string): string {
  return channelId.slice('ext-'.length)
}

async function handleEvent(ev: AriEvent): Promise<void> {
  if (ev.type === 'StasisStart' && ev.channel) {
    const channelId = ev.channel.id
    const args = ev.args ?? []

    if (isExternalChannelId(channelId)) {
      const inboundId = inboundIdFromExternal(channelId)
      const cs = calls.get(inboundId)
      if (!cs) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ARI] external started but no call state inbound=${inboundId} ext=${channelId}`,
        )
        return
      }

      // eslint-disable-next-line no-console
      console.log(
        `[ARI] external media channel entered stasis ext=${channelId} inbound=${inboundId} state=${ev.channel.state ?? ''}`,
      )

      // Some setups won't start media until the external channel is answered.
      // If this fails (e.g. already up), we just log and continue.
      try {
        await ari.answer(channelId)
        // eslint-disable-next-line no-console
        console.log(`[ARI] external channel answered ext=${channelId}`)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[ARI] external channel answer failed ext=${channelId}`, e)
      }

      await ari.addChannelToBridge(cs.bridgeId, channelId)
      return
    }

    // inbound call
    if (!args.includes('inbound')) {
      // eslint-disable-next-line no-console
      console.log(
        `[ARI] StasisStart (ignored) chan=${channelId} args=${args.join(',')}`,
      )
      return
    }

    if (calls.size > 0) {
      try {
        await ari.hangup(channelId, 'busy')
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[ARI] hangup failed chan=${channelId}`, e)
      }
      return
    }

    const cs = getOrCreateCallByInbound(channelId)

    wsHub.broadcastJson({
      type: 'call-start',
      callId: cs.callId,
      inboundChannelId: cs.inboundChannelId,
      caller: ev.channel.caller?.number ?? null,
      channelName: ev.channel.name ?? null,
      startedAt: cs.startedAt,
    })

    // eslint-disable-next-line no-console
    console.log(
      `[CALL] inbound start id=${channelId} name=${ev.channel.name} caller=${ev.channel.caller?.number ?? ''}`,
    )

    await ari.answer(channelId)
    await ari.createBridge(cs.bridgeId)
    await ari.addChannelToBridge(cs.bridgeId, channelId)

    // Must be reachable from the Asterisk instance.
    // In Docker Compose, set EXTERNAL_MEDIA_HOST to the Node service name (e.g. sip-client-node:5004).
    // For local (non-Docker) runs where Asterisk and Node share the host, 127.0.0.1 is typically correct.
    const externalHost = cfg.externalMediaHost || `127.0.0.1:${cfg.rtpPort}`
    // eslint-disable-next-line no-console
    console.log(
      `[ARI] createExternalMedia inbound=${channelId} ext=${cs.externalChannelId} external_host=${externalHost} format=ulaw direction=both`,
    )

    try {
      await ari.createExternalMedia({
        channelId: cs.externalChannelId,
        externalHost,
        format: 'ulaw',
        direction: 'both',
      })
      // eslint-disable-next-line no-console
      console.log(
        `[ARI] createExternalMedia ok inbound=${channelId} ext=${cs.externalChannelId}`,
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[ARI] createExternalMedia failed inbound=${channelId} ext=${cs.externalChannelId}`,
        e,
      )
      throw e
    }

    // Prime the RTP remote so we can inject audio immediately (beep/echo/WS).
    // This is especially useful if Asterisk doesn't send RTP until it receives RTP first.
    void primeRtpRemoteFromAri(cs)

    startBeepOnceRtpIsReady(cs)

    if (cfg.warnIfNoRtpAfterMs > 0) {
      setTimeout(() => {
        const cur = calls.get(channelId)
        if (!cur) return
        if (cur.rtpFirstPacketAt) return
        // eslint-disable-next-line no-console
        console.warn(
          `[RTP] no packets received yet inbound=${channelId} waitedMs=${cfg.warnIfNoRtpAfterMs} (check Asterisk -> externalMedia UDP to ${cfg.rtpPort})`,
        )
      }, cfg.warnIfNoRtpAfterMs)
    }
    return
  }

  if (
    (ev.type === 'StasisEnd' || ev.type === 'ChannelDestroyed') &&
    ev.channel
  ) {
    const channelId = ev.channel.id

    if (isExternalChannelId(channelId)) {
      const inboundId = inboundIdFromExternal(channelId)
      // eslint-disable-next-line no-console
      console.log(`[ARI] external end ext=${channelId} inbound=${inboundId}`)
      return
    }

    const cs = calls.get(channelId)
    if (!cs) return

    // eslint-disable-next-line no-console
    console.log(`[CALL] end inbound=${channelId} event=${ev.type}`)

    wsHub.broadcastJson({
      type: 'call-end',
      callId: cs.callId,
      inboundChannelId: cs.inboundChannelId,
      event: ev.type,
      endedAt: Date.now(),
    })

    try {
      await ari.destroyBridge(cs.bridgeId)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[ARI] destroyBridge failed', e)
    }

    cleanupCall(channelId)
  }
}

// eslint-disable-next-line no-console
console.log(
  `[BOOT] ARI_URL=${cfg.ariUrl} ARI_APP=${cfg.ariApp} WS_PORT=${cfg.wsPort} RTP_PORT=${cfg.rtpPort}`,
)

await ari.connectEvents(ev => {
  handleEvent(ev).catch(e => {
    // eslint-disable-next-line no-console
    console.error('[ARI] handler error', e)
  })
})

// eslint-disable-next-line no-console
console.log('[BOOT] Connected to ARI events')
