import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { Brain } from '../cognitive/conscious/brain'
import type { EventBus, TracedEvent } from '../cognitive/event-bus'
import type { PerceptionSignal } from '../cognitive/perception/types/signals'
import type { CognitiveHost, MineflayerWithAgents } from '../cognitive/types'

import { createServer } from 'node:http'

import { useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { nanoid } from 'nanoid'

/**
 * One thing that happened in the game, as the AITuberKit page sees it.
 * `urgency` tells the page when Helixus should speak about it:
 * - `immediate`: interrupt the idle wait and react now (death, low health).
 * - `soon`: react at the next idle moment (damage, player chat, the planner's own notifications).
 * - `later`: context only, folded into the next line he says anyway.
 */
export interface GameEvent {
  seq: number
  at: number
  kind: 'notify' | 'context' | 'chat_in' | 'chat_out' | 'system' | 'hurt' | 'low_health' | 'death' | 'respawn' | 'command' | 'connection'
  text: string
  urgency: 'immediate' | 'soon' | 'later'
}

export interface HelixusLinkOptions {
  port: number
  /** Browser origins allowed to call the link. Requests without an Origin header (curl, local scripts) are always allowed. */
  allowedOrigins: string[]
}

/** The page polls, so a small ring is enough; it only needs events since its last poll. */
const EVENT_RING_SIZE = 300
const EVENTS_PER_RESPONSE = 50
const MAX_BODY_BYTES = 4096
const MAX_COMMAND_CHARS = 300
/** Damage arrives once per hit; one line per burst of hits is enough for commentary. */
const HURT_EVENT_COOLDOWN_MS = 8_000
const LOW_HEALTH_EVENT_COOLDOWN_MS = 20_000

/**
 * Connects the Minecraft cognitive runtime to Helixus's live page (AITuberKit) instead of the AIRI server.
 *
 * It plays both AIRI roles the brain expects (planner notifications and bot status), and serves a small
 * local HTTP API that the page polls:
 *
 * - `GET  /status`            bot vitals, inventory summary, what the planner is doing
 * - `GET  /events?after=seq`  game events since `seq`
 * - `GET  /trace?limit=n`     the planner's recent LLM turns (diagnostics)
 * - `POST /command {text}`    a directive from Helixus, delivered to the planner like an AIRI `spark:command`
 * - `POST /pause {paused}`    pause or resume the planner (no LLM calls while paused)
 * - `POST /forget`            clear the planner's conversation history
 *
 * Lifecycle: the HTTP server lives for the whole process ({@link start} / {@link stop}). The Mineflayer
 * runtime is rebuilt on every reconnect; each rebuild calls {@link attachRuntime} and {@link bindBot}, and
 * the teardown calls {@link unbindBot} / {@link destroy}, which only drop the per-runtime listeners.
 */
export class HelixusLink implements CognitiveHost {
  private readonly logger = useLogg('helixus-link').useGlobalConfig()
  private server: Server | null = null
  private eventBus: EventBus | null = null
  private brain: Brain | null = null
  private bot: MineflayerWithAgents | null = null
  private detachRuntime: (() => void) | null = null
  private detachBot: (() => void) | null = null
  private events: GameEvent[] = []
  private nextSeq = 1
  private lastHurtAt = 0
  private lastLowHealthAt = 0
  private lastCommand: { text: string, at: number } | null = null

  constructor(private readonly options: HelixusLinkOptions) {}

  /** The bound port; differs from `options.port` when that was 0 (tests). */
  get port(): number {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : this.options.port
  }

  start(): Promise<void> {
    if (this.server)
      return Promise.resolve()

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.logger.withFields({ error: errorMessageFrom(error) }).warn('Request failed')
        if (!res.headersSent)
          this.sendJson(res, 500, { ok: false, reason: 'internal' })
      })
    })
    this.server = server

    return new Promise((resolve, reject) => {
      server.once('error', reject)
      // NOTICE: bind to loopback only. The API drives the bot; it must not be reachable from the LAN.
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject)
        this.logger.log(`Helixus link listening on http://127.0.0.1:${this.options.port}`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server)
      return Promise.resolve()
    return new Promise(resolve => server.close(() => resolve()))
  }

  attachRuntime(runtime: { eventBus: EventBus, brain: Brain }): void {
    this.detachRuntime?.()
    this.eventBus = runtime.eventBus
    this.brain = runtime.brain

    const unsubscribe = runtime.eventBus.subscribe<PerceptionSignal>('signal:*', event => this.onSignal(event))
    this.detachRuntime = () => {
      unsubscribe()
      this.eventBus = null
      this.brain = null
    }
  }

  init(): void {}

  destroy(): void {
    this.unbindBot()
    this.detachRuntime?.()
    this.detachRuntime = null
  }

  bindBot(bot: MineflayerWithAgents): void {
    this.detachBot?.()
    this.bot = bot
    const mc = bot.bot
    let dead = false

    const onDeath = () => {
      dead = true
      this.push('death', '你死了。', 'immediate')
    }
    const onSpawn = () => {
      if (!dead)
        return
      dead = false
      this.push('respawn', '你复活了，回到了出生点，背包里的东西掉在了死的地方。', 'later')
    }
    const onChat = (username: string, message: string) => {
      if (username === mc.username)
        this.push('chat_out', `你在游戏里打字说：${message}`, 'later')
    }
    const onKicked = (reason: unknown) => {
      this.push('connection', `你被服务器踢了出去：${typeof reason === 'string' ? reason : JSON.stringify(reason)}`, 'immediate')
    }

    mc.on('death', onDeath)
    mc.on('spawn', onSpawn)
    mc.on('chat', onChat)
    mc.on('kicked', onKicked)
    this.detachBot = () => {
      mc.off('death', onDeath)
      mc.off('spawn', onSpawn)
      mc.off('chat', onChat)
      mc.off('kicked', onKicked)
    }

    this.push('connection', `你进入了游戏世界（${this.describeServer()}）。`, 'soon')
  }

  unbindBot(): void {
    if (!this.bot)
      return
    this.detachBot?.()
    this.detachBot = null
    this.bot = null
    this.push('connection', '你和游戏世界断开了连接。', 'soon')
  }

  sendNotify(headline: string, note?: string, urgency: 'immediate' | 'soon' | 'later' = 'soon'): void {
    this.push('notify', note ? `${headline}：${note}` : headline, urgency)
  }

  sendContextUpdate(text: string, _hints?: string[], _lane?: string): void {
    this.push('context', text, 'later')
  }

  private push(kind: GameEvent['kind'], text: string, urgency: GameEvent['urgency']) {
    this.events.push({ seq: this.nextSeq++, at: Date.now(), kind, text, urgency })
    if (this.events.length > EVENT_RING_SIZE)
      this.events.splice(0, this.events.length - EVENT_RING_SIZE)
  }

  private onSignal(event: TracedEvent<PerceptionSignal>) {
    const signal = event.payload
    const now = Date.now()
    switch (signal.type) {
      case 'chat_message': {
        const username = String(signal.metadata?.username ?? '有人')
        this.push('chat_in', `${username} 在游戏里说：${String(signal.metadata?.message ?? '')}`, 'soon')
        return
      }
      case 'system_message': {
        const message = String(signal.metadata?.message ?? signal.description)
        // "<name> text" is a chat line echoed by the server: the bot's own lines are already chat_out,
        // other players' lines are already chat_in (signal:chat_message).
        if (/^<[^>]+>\s/.test(message))
          return
        const aboutMe = this.bot && message.includes(this.bot.username)
        this.push('system', `游戏消息：${message}`, aboutMe ? 'soon' : 'later')
        return
      }
      case 'saliency_high': {
        const action = signal.metadata?.action
        if (action === 'low_health') {
          if (now - this.lastLowHealthAt < LOW_HEALTH_EVENT_COOLDOWN_MS)
            return
          this.lastLowHealthAt = now
          this.push('low_health', `血量危险，只剩 ${String(signal.metadata?.health ?? '?')}/20。`, 'immediate')
        }
        else if (action === 'damage') {
          if (now - this.lastHurtAt < HURT_EVENT_COOLDOWN_MS)
            return
          this.lastHurtAt = now
          const from = String(signal.metadata?.source_name || signal.metadata?.cause || '').trim()
          this.push('hurt', `你受伤了${from && from !== 'undefined' ? `（${from}）` : ''}，现在血量 ${this.bot?.bot.health ?? '?'}/20。`, 'soon')
        }
      }
    }
  }

  private describeServer() {
    const host = this.bot?.bot._client?.socket?.remoteAddress
    return host ? `服务器 ${host}` : '本地世界'
  }

  private status() {
    const bot = this.bot
    const mc = bot?.bot
    const entity = mc?.entity
    const debug = this.brain?.getDebugSnapshot()
    const executing = debug?.actionQueue.executing
    const inventory = new Map<string, number>()
    for (const item of mc?.inventory?.items() ?? [])
      inventory.set(item.name, (inventory.get(item.name) ?? 0) + item.count)
    const timeOfDay = mc?.time?.timeOfDay

    return {
      online: Boolean(bot && entity),
      username: bot?.username ?? null,
      paused: debug?.paused ?? false,
      health: mc?.health ?? null,
      food: mc?.food ?? null,
      position: entity ? { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) } : null,
      dimension: mc?.game?.dimension ?? null,
      gameMode: mc?.game?.gameMode ?? null,
      isDay: typeof timeOfDay === 'number' ? timeOfDay < 12542 || timeOfDay > 23460 : null,
      heldItem: mc?.heldItem?.name ?? null,
      inventory: [...inventory.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 16)
        .map(([name, count]) => ({ name, count })),
      otherPlayers: Object.keys(mc?.players ?? {}).filter(name => name !== bot?.username),
      planner: debug
        ? {
            thinking: debug.isProcessing,
            executing: executing ? { tool: executing.tool, params: executing.params } : null,
            pending: debug.actionQueue.counts.pending,
            givenUp: debug.givenUp,
          }
        : null,
      lastCommand: this.lastCommand,
      latestEventSeq: this.nextSeq - 1,
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin
    if (origin) {
      if (!this.options.allowedOrigins.includes(origin)) {
        this.sendJson(res, 403, { ok: false, reason: 'origin not allowed' })
        return
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /status') {
      this.sendJson(res, 200, this.status())
      return
    }

    if (route === 'GET /events') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0
      const events = this.events.filter(e => e.seq > after).slice(-EVENTS_PER_RESPONSE)
      this.sendJson(res, 200, { events, latest: this.nextSeq - 1 })
      return
    }

    // Diagnostics: the planner's recent LLM turns (reply text, token usage, duration), newest last.
    if (route === 'GET /trace') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 10) || 10, 50)
      this.sendJson(res, 200, this.brain?.getLlmTrace(limit) ?? [])
      return
    }

    if (route === 'POST /command') {
      const body = await this.readJson(req)
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (!text || [...text].length > MAX_COMMAND_CHARS) {
        this.sendJson(res, 400, { ok: false, reason: `text must be 1-${MAX_COMMAND_CHARS} characters` })
        return
      }
      if (!this.bot?.bot.entity || !this.eventBus) {
        this.sendJson(res, 409, { ok: false, reason: 'bot offline' })
        return
      }
      const id = this.deliverCommand(text)
      this.sendJson(res, 200, { ok: true, id })
      return
    }

    if (route === 'POST /pause') {
      const body = await this.readJson(req)
      if (!this.brain) {
        this.sendJson(res, 409, { ok: false, reason: 'bot offline' })
        return
      }
      const paused = this.brain.setPaused(body?.paused !== false)
      this.logger.log(`Planner ${paused ? 'paused' : 'resumed'} by the page`)
      this.sendJson(res, 200, { ok: true, paused })
      return
    }

    if (route === 'POST /forget') {
      if (!this.brain) {
        this.sendJson(res, 409, { ok: false, reason: 'bot offline' })
        return
      }
      this.sendJson(res, 200, this.brain.forgetConversation())
      return
    }

    this.sendJson(res, 404, { ok: false, reason: 'not found' })
  }

  /**
   * Same path as AIRI's `spark:command`: an `airi_command` signal wakes the planner for a fresh decision,
   * and the brain prompt treats it as a high-priority directive from the character that oversees the bot.
   */
  private deliverCommand(text: string) {
    const id = nanoid()
    this.lastCommand = { text, at: Date.now() }
    this.push('command', `你下达了指令：${text}`, 'later')
    this.logger.log(`Directive from Helixus: ${text}`)
    this.eventBus?.emit({
      type: 'signal:airi_command',
      payload: Object.freeze({
        type: 'airi_command' as const,
        description: `Directive from AIRI: "${text}"`,
        sourceId: 'airi',
        confidence: 1.0,
        timestamp: Date.now(),
        metadata: { message: text, sparkCommandId: id, sparkIntent: 'action' },
      }),
      source: { component: 'airi', id: 'helixus-link' },
    })
    return id
  }

  private readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0)
          return resolve(null)
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null)
        }
        catch {
          resolve(null)
        }
      })
      req.on('error', reject)
    })
  }

  private sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
}
