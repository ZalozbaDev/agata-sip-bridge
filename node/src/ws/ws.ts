import { WebSocketServer, type WebSocket } from 'ws'

export class WsHub {
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private connectionHandlers: Array<(ws: WebSocket) => void> = []
  private binaryHandlers: Array<(data: Buffer) => void> = []

  constructor(private port: number) {
    this.wss = new WebSocketServer({ port })

    this.wss.on('listening', () => {
      // eslint-disable-next-line no-console
      console.log(`[WS] listening on 0.0.0.0:${port}/tcp`)
    })

    this.wss.on('error', err => {
      // eslint-disable-next-line no-console
      console.error(`[WS] server error on port ${port}`, err)
      process.exitCode = 1
    })

    this.wss.on('connection', ws => {
      this.clients.add(ws)
      // eslint-disable-next-line no-console
      console.log(`[WS] client connected clients=${this.clients.size}`)

      for (const h of this.connectionHandlers) h(ws)

      ws.on('message', (data, isBinary) => {
        if (!isBinary) return
        const b = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer)
        for (const h of this.binaryHandlers) h(b)
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        // eslint-disable-next-line no-console
        console.log(`[WS] client disconnected clients=${this.clients.size}`)
      })
    })
  }

  onConnection(handler: (ws: WebSocket) => void): void {
    this.connectionHandlers.push(handler)
  }

  onBinary(handler: (data: Buffer) => void): void {
    this.binaryHandlers.push(handler)
  }

  broadcastJson(obj: unknown): void {
    const s = JSON.stringify(obj)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(s)
    }
  }

  broadcastBinary(buf: Buffer): void {
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(buf)
    }
  }
}
