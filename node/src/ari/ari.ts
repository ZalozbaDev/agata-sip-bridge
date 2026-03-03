import axios, { type AxiosInstance } from 'axios'
import WebSocket from 'ws'

export type AriEvent = {
  type: string
  timestamp: string
  application?: string
  channel?: {
    id: string
    name: string
    state?: string
    caller?: { number?: string; name?: string }
    connected?: { number?: string; name?: string }
  }
  bridge?: { id: string; bridge_type?: string }
  args?: string[]
}

export class AriClient {
  private http: AxiosInstance
  private ws?: WebSocket
  private reconnectTimer?: NodeJS.Timeout

  constructor(
    private cfg: { ariUrl: string; user: string; pass: string; app: string },
  ) {
    this.http = axios.create({
      baseURL: cfg.ariUrl,
      auth: { username: cfg.user, password: cfg.pass },
      timeout: 10_000,
    })
  }

  async connectEvents(onEvent: (ev: AriEvent) => void): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    if (this.ws) {
      try {
        this.ws.terminate()
      } catch {
        // ignore
      }
      this.ws = undefined
    }

    const wsBase = this.cfg.ariUrl.replace(/^http/i, 'ws')
    const url = new URL(wsBase + '/events')
    url.searchParams.set('app', this.cfg.app)
    url.searchParams.set('api_key', `${this.cfg.user}:${this.cfg.pass}`)

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

    let attempt = 0
    // Retry loop for startup when Asterisk is not ready yet (503/ECONNREFUSED)
    while (true) {
      attempt++
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(url.toString())
          this.ws = ws

          let opened = false

          ws.once('open', () => {
            opened = true
            resolve()
          })
          ws.once('error', err => reject(err))

          ws.on('message', data => {
            try {
              const ev = JSON.parse(data.toString()) as AriEvent
              onEvent(ev)
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('[ARI] invalid event JSON', e)
            }
          })

          ws.once('close', () => {
            // eslint-disable-next-line no-console
            console.error('[ARI] event websocket closed')

            // If we never reached open(), this close is likely part of a failed handshake
            // (e.g. 503 while Asterisk starts). In that case, do NOT start a parallel reconnect loop.
            if (!opened) return

            this.reconnectTimer = setTimeout(() => {
              void this.connectEvents(onEvent)
            }, 1000)
          })
        })

        // eslint-disable-next-line no-console
        console.log('[ARI] events websocket connected')
        return
      } catch (e) {
        const waitMs = Math.min(10_000, 500 + attempt * 500)
        // eslint-disable-next-line no-console
        console.warn(
          `[ARI] connect failed (attempt ${attempt}), retrying in ${waitMs}ms`,
          e,
        )
        await sleep(waitMs)
      }
    }
  }

  async answer(channelId: string): Promise<void> {
    await this.http.post(`/channels/${encodeURIComponent(channelId)}/answer`)
  }

  async hangup(channelId: string, cause?: string): Promise<void> {
    if (cause) {
      await this.http.delete(`/channels/${encodeURIComponent(channelId)}`, {
        params: { reason: cause },
      })
    } else {
      await this.http.delete(`/channels/${encodeURIComponent(channelId)}`)
    }
  }

  async createBridge(bridgeId: string): Promise<void> {
    await this.http.post('/bridges', null, {
      params: { type: 'mixing', bridgeId },
    })
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    await this.http.delete(`/bridges/${encodeURIComponent(bridgeId)}`)
  }

  async addChannelToBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.http.post(
      `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
      null,
      {
        params: { channel: channelId },
      },
    )
  }

  async removeChannelFromBridge(
    bridgeId: string,
    channelId: string,
  ): Promise<void> {
    await this.http.post(
      `/bridges/${encodeURIComponent(bridgeId)}/removeChannel`,
      null,
      {
        params: { channel: channelId },
      },
    )
  }

  async createExternalMedia(opts: {
    channelId: string
    externalHost: string // host:port
    format: string // e.g. ulaw
    direction: 'both' | 'in' | 'out'
  }): Promise<void> {
    await this.http.post('/channels/externalMedia', null, {
      params: {
        app: this.cfg.app,
        channelId: opts.channelId,
        external_host: opts.externalHost,
        format: opts.format,
        direction: opts.direction,
      },
    })
  }

  async getChannelVar(
    channelId: string,
    variable: string,
  ): Promise<string | undefined> {
    try {
      const res = await this.http.get(
        `/channels/${encodeURIComponent(channelId)}/variable`,
        {
          params: { variable },
        },
      )
      const v = (res.data as { value?: unknown } | undefined)?.value
      return typeof v === 'string' ? v : undefined
    } catch {
      return undefined
    }
  }

  async indicate(
    channelId: string,
    indication: 'busy' | 'congestion' | 'ringing',
  ): Promise<void> {
    await this.http.post(
      `/channels/${encodeURIComponent(channelId)}/indicate`,
      null,
      {
        params: { indication },
      },
    )
  }
}
