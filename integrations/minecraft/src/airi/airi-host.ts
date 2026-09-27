import type { Logg } from '@guiiai/logg'

import type { Brain } from '../cognitive/conscious/brain'
import type { EventBus } from '../cognitive/event-bus'
import type { CognitiveHost, MineflayerWithAgents } from '../cognitive/types'

import { Client } from '@proj-airi/server-sdk'

import { config } from '../composables/config'
import { AiriBridge } from './airi-bridge'
import { MinecraftContextService } from './minecraft-context-service'
import { startAiriClientConnection } from './start-background-client'

/**
 * The upstream host: the bot reports to, and takes commands from, the AIRI server.
 * The bridge and status service are rebuilt for every bot runtime because the bridge needs that
 * runtime's event bus; the websocket client lives for the whole process.
 */
class AiriHost implements CognitiveHost {
  private bridge: AiriBridge | null = null
  private context: MinecraftContextService | null = null

  constructor(private readonly client: Client) {}

  attachRuntime(runtime: { eventBus: EventBus, brain: Brain }) {
    this.bridge = new AiriBridge(this.client, runtime.eventBus)
    this.context = new MinecraftContextService({
      airiBridge: this.bridge,
      serverHost: config.bot.host,
      serverPort: config.bot.port,
      masterUsername: config.bot.masterUsername,
    })
  }

  init() {
    this.bridge?.init()
    this.context?.init()
  }

  destroy() {
    this.context?.destroy()
    this.bridge?.destroy()
  }

  sendNotify(headline: string, note?: string, urgency?: 'immediate' | 'soon' | 'later') {
    this.bridge?.sendNotify(headline, note, urgency)
  }

  sendContextUpdate(text: string, hints?: string[], lane?: string) {
    this.bridge?.sendContextUpdate(text, hints, lane)
  }

  bindBot(bot: MineflayerWithAgents) {
    this.context?.bindBot(bot)
  }

  unbindBot() {
    this.context?.unbindBot()
  }
}

/**
 * Connects to the AIRI server in the background and returns the host the cognitive engine reports through.
 * `onConfigure` receives the Stage's `module:configure` payloads (enable/disable, server address).
 */
export function connectAiriHost(deps: {
  logger: Logg
  onConfigure: (config: unknown) => Promise<void>
}): { host: CognitiveHost, close: () => void } {
  let lifecycle: ReturnType<typeof startAiriClientConnection> | null = null
  const client = new Client({
    name: config.airi.clientName,
    url: config.airi.wsBaseUrl,
    token: config.airi.token || undefined,
    possibleEvents: ['module:configure', 'module:announced', 'spark:command', 'context:update'],
    autoConnect: false,
    // NOTICE:
    // The bot's Node event loop occasionally goes quiet for ~30s (busy mineflayer packet handling /
    // perception ticks), during which the heartbeat ping timer can't fire, so the default 30s
    // readTimeout would trip and tear down the AIRI connection — making the in-game bot flap
    // online/offline and the desktop's game-command relay unusable. Widen the read tolerance to 120s
    // (still under the server's 60s-per-miss TTL for a single ~30s gap) and keep pings frequent so
    // the connection recovers immediately once the loop frees up.
    // Root cause (the periodic event-loop stall itself) is tracked separately.
    heartbeat: { readTimeout: 120_000, pingInterval: 20_000 },
    onError: error => lifecycle?.reportUnavailable(error),
    onClose: () => lifecycle?.reportDisconnected(),
  })
  lifecycle = startAiriClientConnection(client, {
    logger: deps.logger,
    url: config.airi.wsBaseUrl,
  })

  client.onEvent('module:configure', async (event) => {
    try {
      await deps.onConfigure(event.data.config)
    }
    catch {
      // Keep failures local to the service process. Stage learns only from registry liveness
      // and explicit bot-originated context pushes, not automated configure updates.
    }
  })

  return {
    host: new AiriHost(client),
    // TODO: Add an explicit AIRI-side deregistration path on shutdown instead of relying on
    // websocket close / heartbeat expiry. Right now the Minecraft page can briefly sit in a
    // stale state after the bot exits, which is annoying and easy to misread as still online.
    close: () => client.close(),
  }
}
