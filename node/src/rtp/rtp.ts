import dgram from 'node:dgram'
import crypto from 'node:crypto'

export type RtpPacket = {
  payloadType: number
  sequenceNumber: number
  timestamp: number
  ssrc: number
  marker: boolean
  payload: Buffer
  remote: { address: string; port: number }
}

type RtpRemote = { address: string; port: number }

type SendState = {
  seq: number
  timestamp: number
  ssrc: number
  initializedFromRx: boolean
}

export class RtpEndpoint {
  private sock = dgram.createSocket('udp4')
  private remote?: RtpRemote
  private lastRemoteKey?: string
  private sendStates = new Map<string, SendState>()
  private packetCount = 0

  constructor(
    private opts: { port: number; logEveryN: number; payloadType: number },
  ) {}

  async start(onPacket: (pkt: RtpPacket) => void): Promise<void> {
    this.sock.on('message', (msg, rinfo) => {
      const pkt = this.parsePacket(msg, {
        address: rinfo.address,
        port: rinfo.port,
      })
      if (!pkt) return

      const remoteKey = `${rinfo.address}:${rinfo.port}`
      this.remote = { address: rinfo.address, port: rinfo.port }

      // Seed per-remote send timeline from RX (helps echo/injection feel aligned).
      const st = this.getOrCreateSendState(pkt.remote)
      if (!st.initializedFromRx) {
        st.initializedFromRx = true
        st.seq = pkt.sequenceNumber
        st.timestamp = pkt.timestamp
      }

      if (!this.lastRemoteKey) {
        this.lastRemoteKey = remoteKey
        // eslint-disable-next-line no-console
        console.log(
          `[RTP] rx first remote=${remoteKey} pt=${pkt.payloadType} seq=${pkt.sequenceNumber} ts=${pkt.timestamp} bytes=${pkt.payload.length}`,
        )
      } else if (this.lastRemoteKey !== remoteKey) {
        // eslint-disable-next-line no-console
        console.warn(
          `[RTP] remote changed ${this.lastRemoteKey} -> ${remoteKey}`,
        )
        this.lastRemoteKey = remoteKey
      }
      this.packetCount++
      if (
        this.opts.logEveryN > 0 &&
        this.packetCount % this.opts.logEveryN === 0
      ) {
        // eslint-disable-next-line no-console
        console.log(
          `[RTP] rx packets=${this.packetCount} remote=${rinfo.address}:${rinfo.port} pt=${pkt.payloadType} seq=${pkt.sequenceNumber} ts=${pkt.timestamp} bytes=${pkt.payload.length}`,
        )
      }

      onPacket(pkt)
    })

    await new Promise<void>(resolve => {
      this.sock.bind(this.opts.port, '0.0.0.0', () => resolve())
    })

    // eslint-disable-next-line no-console
    console.log(`[RTP] listening on 0.0.0.0:${this.opts.port}/udp`)
  }

  stop(): void {
    this.sock.close()
  }

  hasRemote(): boolean {
    return Boolean(this.remote)
  }

  setRemote(remote: RtpRemote): void {
    this.remote = remote
    this.lastRemoteKey = `${remote.address}:${remote.port}`
    // Ensure send state exists so we can transmit even before first RX.
    this.getOrCreateSendState(remote)
  }

  sendPayload(payload: Buffer, samplesPerPacket: number): void {
    if (!this.remote) return
    this.sendPayloadTo(this.remote, payload, samplesPerPacket)
  }

  sendPayloadTo(
    remote: RtpRemote,
    payload: Buffer,
    samplesPerPacket: number,
  ): void {
    const st = this.getOrCreateSendState(remote)

    st.seq = (st.seq + 1) & 0xffff
    st.timestamp = (st.timestamp + samplesPerPacket) >>> 0

    const header = Buffer.alloc(12)
    header[0] = 0x80 // V=2
    header[1] = this.opts.payloadType & 0x7f // M=0
    header.writeUInt16BE(st.seq, 2)
    header.writeUInt32BE(st.timestamp >>> 0, 4)
    header.writeUInt32BE(st.ssrc >>> 0, 8)

    const pkt = Buffer.concat([header, payload])
    this.sock.send(pkt, remote.port, remote.address)
  }

  private getOrCreateSendState(remote: RtpRemote): SendState {
    const key = `${remote.address}:${remote.port}`
    const existing = this.sendStates.get(key)
    if (existing) return existing

    const st: SendState = {
      seq: crypto.randomInt(0, 0xffff),
      timestamp: crypto.randomInt(0, 0xffffffff) >>> 0,
      ssrc: crypto.randomInt(1, 0xffffffff),
      initializedFromRx: false,
    }
    this.sendStates.set(key, st)
    return st
  }

  private parsePacket(
    buf: Buffer,
    remote: { address: string; port: number },
  ): RtpPacket | null {
    if (buf.length < 12) return null
    const v = buf[0] >> 6
    if (v !== 2) return null

    const cc = buf[0] & 0x0f
    const x = (buf[0] & 0x10) !== 0

    const marker = (buf[1] & 0x80) !== 0
    const payloadType = buf[1] & 0x7f

    const sequenceNumber = buf.readUInt16BE(2)
    const timestamp = buf.readUInt32BE(4)
    const ssrc = buf.readUInt32BE(8)

    let offset = 12 + cc * 4
    if (offset > buf.length) return null

    if (x) {
      if (offset + 4 > buf.length) return null
      // header extension: 16-bit profile + 16-bit length (in 32-bit words)
      const extLenWords = buf.readUInt16BE(offset + 2)
      offset += 4 + extLenWords * 4
      if (offset > buf.length) return null
    }

    const payload = buf.subarray(offset)

    return {
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc,
      marker,
      payload,
      remote,
    }
  }
}
