import type { Mineflayer } from '../../libs/mineflayer'
import type { Brain } from '../conscious/brain'
import type { EventBus } from '../event-bus'
import type { ReflexManager } from '../reflex/reflex-manager'

export interface MineflayerWithAgents extends Mineflayer {
  reflexManager: ReflexManager
}

/**
 * The part of the host seam that the brain talks to: the `notifyAiri` / `updateAiriContext` planner tools.
 * Implemented by the AIRI server bridge and by the Helixus live link.
 */
export interface CognitiveBridge {
  init: () => void
  destroy: () => void
  sendNotify: (headline: string, note?: string, urgency?: 'immediate' | 'soon' | 'later') => void
  sendContextUpdate: (text: string, hints?: string[], lane?: string) => void
}

/** Follows the Mineflayer runtime lifecycle so the host can report bot status. */
export interface CognitiveContextService {
  init: () => void
  destroy: () => void
  bindBot: (bot: MineflayerWithAgents) => void
  unbindBot: () => void
}

/**
 * Where the bot reports to and takes commands from: the AIRI server, or Helixus's live page.
 * It outlives one bot runtime: the engine attaches each rebuilt runtime (event bus, brain) after a reconnect.
 */
export interface CognitiveHost extends CognitiveBridge, CognitiveContextService {
  attachRuntime: (runtime: { eventBus: EventBus, brain: Brain }) => void
}

export interface CognitiveEngineOptions {
  host: CognitiveHost
}

// TODO: currently stimulus is just chat events, consider renaming to 'input' or 'user_interaction'
export type EventCategory = 'perception' | 'feedback' | 'system_alert'

export interface BotEventSource {
  type: 'minecraft' | 'airi' | 'system'
  id: string // Agent/Source identifier
  reply?: (message: string) => void
}

// FIXME unsafe type
export interface BotEvent<T = any> {
  type: EventCategory
  payload: T
  source: BotEventSource
  timestamp: number
  // Layered Architecture Metadata
  priority?: number // Higher is more urgent
  handled?: boolean // Set by Reflex layer to inhibit Conscious layer
}
