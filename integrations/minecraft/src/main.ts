import process, { exit } from 'node:process'

import type { CognitiveHost } from './cognitive/types'

import MineflayerArmorManager from 'mineflayer-armor-manager'

import { loader as MineflayerAutoEat } from 'mineflayer-auto-eat'
import { plugin as MineflayerCollectBlock } from 'mineflayer-collectblock'
import { pathfinder as MineflayerPathfinder } from 'mineflayer-pathfinder'
import { plugin as MineflayerPVP } from 'mineflayer-pvp'
import { plugin as MineflayerTool } from 'mineflayer-tool'

import { CognitiveEngine } from './cognitive'
import { config, initEnv } from './composables/config'
import { MinecraftRuntimeConfigManager } from './composables/runtime-config'
import { DebugService } from './debug'
import { setupMineflayerViewer } from './debug/mineflayer-viewer'
import { HelixusLink } from './helixus/helixus-link'
import { Mineflayer, wrapPlugin } from './libs/mineflayer'
import { MinecraftBotRuntime } from './minecraft-bot-runtime'
import { initLogger, useLogger } from './utils/logger'

/** Shape of `./airi/airi-host`, which is loaded only in AIRI mode (see the NOTICE in `main`). */
interface AiriHostModule {
  connectAiriHost: (deps: {
    logger: ReturnType<typeof useLogger>
    onConfigure: (config: unknown) => Promise<void>
  }) => { host: CognitiveHost, close: () => void }
}

// ...

async function main() {
  initLogger() // todo: save logs to file
  initEnv()
  const logger = useLogger()

  const runtimeConfigManager = new MinecraftRuntimeConfigManager()
  const configManager = {
    load: () => {
      const snapshot = runtimeConfigManager.load()
      config.bot = {
        ...config.bot,
        ...snapshot.effectiveBotConfig,
      }
      return snapshot
    },
    save: (editableConfig: Parameters<MinecraftRuntimeConfigManager['save']>[0]) => {
      const snapshot = runtimeConfigManager.save(editableConfig)
      config.bot = {
        ...config.bot,
        ...snapshot.effectiveBotConfig,
      }
      return snapshot
    },
  }

  let runtimeSnapshot = configManager.load()

  if (config.debug.server || config.debug.viewer || config.debug.mcp) {
    logger.warn(
      [
        '==============================================================================',
        'SECURITY NOTICE:',
        'The MCP Server, Debug Server, and/or Prismarine Viewer endpoints are currently',
        'enabled. These endpoints are completely unauthenticated. Enabling these exposes',
        'your bot\'s internal state and capabilities to anyone who can reach the ports.',
        'This can lead to Remote Code Execution (RCE) and full compromise of the bot',
        'if exposed to the internet or untrusted local networks. Ensure they are not',
        'externally accessible.',
        '==============================================================================',
      ].join('\n'),
    )
  }

  // Start debug server
  if (config.debug.server) {
    DebugService.getInstance().start()
  }

  // Pick the host the bot reports to and takes commands from.
  // Helixus live mode (HELIXUS_LINK_PORT set): the AITuberKit page drives the bot through a local HTTP
  // link and the AIRI server is never contacted. Otherwise: the upstream AIRI server.
  let host: CognitiveHost
  let closeHost: () => void
  const helixusLinkPort = Number(process.env.HELIXUS_LINK_PORT)
  if (Number.isInteger(helixusLinkPort) && helixusLinkPort > 0) {
    const helixusLink = new HelixusLink({
      port: helixusLinkPort,
      allowedOrigins: (process.env.HELIXUS_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean),
    })
    await helixusLink.start()
    host = helixusLink
    closeHost = () => void helixusLink.stop()
  }
  else {
    // NOTICE:
    // The AIRI host needs @proj-airi/server-sdk, which exists only inside the pnpm workspace
    // (its dependency @proj-airi/better-ws is not published to npm). The helixus branch installs this
    // module standalone with npm, so the AIRI host is loaded only when it is used, and through a
    // non-literal specifier so a standalone typecheck does not pull the AIRI files in.
    // Removal condition: server-sdk and all its dependencies are installable from npm.
    const airiHostModule: string = './airi/airi-host'
    const { connectAiriHost } = await import(airiHostModule) as AiriHostModule
    const airi = connectAiriHost({ logger, onConfigure: nextConfig => applyConfiguredRuntime(nextConfig) })
    host = airi.host
    closeHost = airi.close
  }

  let activeRuntime: MinecraftBotRuntime | null = null
  let viewerInitialized = false

  async function createManagedBot(botConfig: typeof config.bot) {
    const runtime = new MinecraftBotRuntime({
      initialConfig: botConfig,
      createBot: async (nextBotConfig) => {
        config.bot = {
          ...config.bot,
          ...nextBotConfig,
        }

        const bot = await Mineflayer.asyncBuild({
          botConfig: nextBotConfig,
          plugins: [
            wrapPlugin(MineflayerArmorManager),
            wrapPlugin(MineflayerAutoEat),
            wrapPlugin(MineflayerCollectBlock),
            wrapPlugin(MineflayerPathfinder),
            wrapPlugin(MineflayerPVP),
            wrapPlugin(MineflayerTool),
          ],
          reconnect: {
            enabled: true,
            maxRetries: 5,
          },
        })

        if (config.debug.viewer && !viewerInitialized) {
          setupMineflayerViewer(bot, { port: 3007, firstPerson: true })
          viewerInitialized = true
        }

        await bot.loadPlugin(CognitiveEngine({ host }))

        // Setup Tool Executor for Debug Dashboard
        const { setupToolExecutor } = await import('./debug/tool-executor')
        setupToolExecutor(bot)

        return bot
      },
    })

    await runtime.initialize()
    activeRuntime = runtime

    return runtime
  }

  async function ensureManagedBot() {
    if (activeRuntime)
      return

    await createManagedBot(runtimeSnapshot.effectiveBotConfig)
  }

  async function applyConfiguredRuntime(nextConfig: unknown) {
    runtimeSnapshot = configManager.save(nextConfig as Parameters<MinecraftRuntimeConfigManager['save']>[0])

    if (!runtimeSnapshot.editableConfig.enabled) {
      if (activeRuntime) {
        await activeRuntime.stop()
        activeRuntime = null
      }
      return
    }

    if (!activeRuntime) {
      await ensureManagedBot()
      return
    }

    await activeRuntime.updateBotConfig(runtimeSnapshot.effectiveBotConfig)
  }

  if (runtimeSnapshot.editableConfig.enabled) {
    await ensureManagedBot()
  }

  process.on('SIGINT', () => {
    Promise.resolve(activeRuntime?.stop())
      .catch((err: Error) => {
        logger.errorWithError('Failed to stop Minecraft runtime cleanly', err)
      })
      .finally(() => {
        closeHost()
        exit(0)
      })
  })
}

main().catch((err: Error) => {
  useLogger().errorWithError('Fatal error', err)
  exit(1)
})
