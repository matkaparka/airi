import type { Brain } from '../cognitive/conscious/brain'
import type { TracedEvent } from '../cognitive/event-bus'
import type { PerceptionSignal } from '../cognitive/perception/types/signals'
import type { MineflayerWithAgents } from '../cognitive/types'

import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createEventBus } from '../cognitive/event-bus'
import { HelixusLink } from './helixus-link'

const PAGE_ORIGIN = 'http://localhost:3000'

async function getJson<T>(url: string): Promise<T> {
  return await (await fetch(url)).json() as T
}

interface EventsResponse {
  latest: number
  events: { kind: string, urgency: string, text: string }[]
}

function fakeBot() {
  const mc = Object.assign(new EventEmitter(), {
    username: 'Helixus',
    entity: { position: { x: 10.4, y: 64, z: -3.6 } },
    health: 18,
    food: 20,
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 1000 },
    heldItem: { name: 'stone_pickaxe' },
    inventory: { items: () => [{ name: 'oak_log', count: 5 }, { name: 'oak_log', count: 3 }, { name: 'dirt', count: 2 }] },
    players: { Helixus: {}, Liam: {} },
  })
  return { username: 'Helixus', bot: mc } as unknown as MineflayerWithAgents
}

function fakeBrain() {
  return {
    getDebugSnapshot: () => ({
      isProcessing: false,
      paused: false,
      givenUp: false,
      actionQueue: { executing: { tool: 'collectBlocks', params: { type: 'oak_log' } }, counts: { pending: 1 } },
    }),
    setPaused: vi.fn((paused: boolean) => paused),
    forgetConversation: vi.fn(() => ({ ok: true, cleared: ['history'] })),
  } as unknown as Brain
}

describe('helixus link', () => {
  let link: HelixusLink
  let base: string
  const eventBus = createEventBus()

  beforeEach(async () => {
    link = new HelixusLink({ port: 0, allowedOrigins: [PAGE_ORIGIN] })
    await link.start()
    base = `http://127.0.0.1:${link.port}`
  })

  afterEach(async () => {
    link.destroy()
    await link.stop()
  })

  it('delivers a page command to the planner as an airi_command signal', async () => {
    const received: TracedEvent<PerceptionSignal>[] = []
    eventBus.subscribe<PerceptionSignal>('signal:airi_command', event => received.push(event))
    link.attachRuntime({ eventBus, brain: fakeBrain() })
    link.bindBot(fakeBot())

    const res = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': PAGE_ORIGIN },
      body: JSON.stringify({ text: '去砍五块橡木' }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGE_ORIGIN)
    expect(received).toHaveLength(1)
    expect(received[0].payload.metadata.message).toBe('去砍五块橡木')
  })

  it('refuses commands while no bot is in the world', async () => {
    link.attachRuntime({ eventBus, brain: fakeBrain() })

    const res = await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })

    expect(res.status).toBe(409)
  })

  it('rejects browser origins outside the allowlist', async () => {
    const res = await fetch(`${base}/status`, { headers: { Origin: 'https://evil.example' } })

    expect(res.status).toBe(403)
  })

  it('reports vitals, a merged inventory, and what the planner is doing', async () => {
    link.attachRuntime({ eventBus, brain: fakeBrain() })
    link.bindBot(fakeBot())

    const status = await getJson<{ inventory: { name: string, count: number }[] }>(`${base}/status`)

    expect(status).toMatchObject({
      online: true,
      health: 18,
      position: { x: 10, y: 64, z: -4 },
      isDay: true,
      otherPlayers: ['Liam'],
      planner: { executing: { tool: 'collectBlocks' }, pending: 1 },
    })
    expect(status.inventory[0]).toEqual({ name: 'oak_log', count: 8 })
  })

  it('turns bot and perception events into page events since a sequence number', async () => {
    link.attachRuntime({ eventBus, brain: fakeBrain() })
    const bot = fakeBot()
    link.bindBot(bot)
    const { latest } = await getJson<EventsResponse>(`${base}/events`)

    bot.bot.emit('death')
    eventBus.emit({
      type: 'signal:chat_message',
      payload: { type: 'chat_message', description: '', timestamp: Date.now(), metadata: { username: 'Liam', message: '过来' } },
      source: { component: 'perception', id: 'chat' },
    })

    const { events } = await getJson<EventsResponse>(`${base}/events?after=${latest}`)
    expect(events.map(e => [e.kind, e.urgency])).toEqual([
      ['death', 'immediate'],
      ['chat_in', 'soon'],
    ])
    expect(events[1].text).toContain('过来')
  })
})
