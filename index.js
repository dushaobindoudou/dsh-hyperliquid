/**
 * dsh-hyperliquid — host half.
 *
 * Publishes the `hyper` Remote namespace (Typert, dsh-bots-anchored), registers
 * the hyper_* agent tools, and contributes a short system-prompt section so
 * agents in any session know the trading desk exists and how to drive it.
 * The client half (client.js) renders the peer-level trading platform.
 *
 * @module dsh-hyperliquid
 */

import { randomUUID } from 'node:crypto'
import { deskPrompt } from './lib/prompt.js'
import { createAgentWaker, marketBarWakeText } from './lib/wake.js'
import { createStrategyBarMonitor } from './lib/strategy-monitor.js'
import { createTurnOriginGuard } from './lib/turn-origin.js'
import { HyperRemote } from './lib/remote.js'
import { buildToolDefinitions } from './lib/tools.js'
import { registerHyperSkill } from './lib/skill.js'

export const name = 'dsh-hyperliquid'

/** Optional services only: without `tools` the desk still serves the UI. */
export const inject = []

let z = null
try {
  // Prefer the HOST's schemastery copy (same implementation the loader
  // validates with) resolved through the dsh-bin anchor; fall back to the
  // bundled copy. require(esm) — Node ≥ 22.12.
  const { createRequire } = await import('node:module')
  const { realpathSync } = await import('node:fs')
  try {
    const anchor = realpathSync(process.argv?.[1] ?? '')
    z = createRequire(anchor)('@deepseek-ai/schemastery')
    if (!z || typeof z.object !== 'function') z = null
  } catch { /* anchor unavailable → bundled copy */ }
  if (!z) z = (await import('@deepseek-ai/schemastery')).default
} catch (err) {
  throw new Error(`[dsh-hyperliquid] schemastery 加载失败：${String(err?.message ?? err)}`)
}

export const Config = z.object({
  dataDir: z.string().description('插件数据目录（交易会话登记表与 paper 账户落盘处）').default('~/.dsh-hyperliquid'),
  network: z.union([z.const('mainnet'), z.const('testnet')]).description('Hyperliquid 网络，默认 mainnet；testnet 可在交易台「更多」中切换').default('mainnet'),
  tradingMode: z.union([z.const('paper'), z.const('live')]).description('交易模式：live 真实签名下单（默认），paper 本地撮合；可在交易台「更多」中切换').default('live'),
  privateKey: z.string().description('Hyperliquid 钱包私钥（signer=local 时使用；建议用 agent wallet 派生密钥；留空则 live 不可用）。也可用环境变量 HYPERLIQUID_PRIVATE_KEY').default(''),
  signer: z.union([z.const('local'), z.const('web3')]).description('签名方式：local 插件内私钥签名；web3 交给 dsh-web3 钱包保险库签名（私钥不出保险库，逐笔过签名策略与审批）').default('local'),
  web3Account: z.string().description('signer=web3 时使用的 dsh-web3 账户 id 或名称').default('main'),
  tradingAddress: z.string().description('Hyperliquid 主账户地址；使用 dsh-web3 API wallet 签名时必填，账户查询必须用主账户地址').default(''),
  autonomousLive: z.boolean().description('初始托管模式：true=全托管（agent 自主执行实盘、可调整限额与划转保证金），false=半托管；之后以交易台 设置 → 托管模式 为准。仅支持 dsh-web3 签名').default(false),
  allowedCoins: z.string().description('交易限额（paper/live 均生效）：允许新开仓的币对，逗号分隔；* 表示全部可交易市场；减仓不受限').default('BTC,ETH'),
  maxOrderUsd: z.number().description('交易限额（paper/live 均生效）：单笔名义价值上限 USD').default(100),
  maxDailyUsd: z.number().description('交易限额（paper/live 均生效）：每 UTC 日累计开仓名义价值上限 USD，paper 与 live 分账').default(500),
  maxPositionUsd: z.number().description('交易限额（paper/live 均生效）：每币最大仓位名义价值 USD').default(500),
  maxLeverage: z.number().description('交易限额（paper/live 均生效）：最大杠杆倍数').default(2),
  wakeAgentOnAlert: z.boolean().description('价格提醒触发时唤醒该交易会话的 agent（只通知并复核，不会自动交易；同一会话 5 分钟内最多一次）').default(true),
  agentAutoTradeTestnet: z.boolean().description('自主交易开关：已收盘 15m K 线唤醒 agent；开启后（live + 全托管，testnet 与 mainnet 均生效）自动轮可执行除提现外的全部交易操作：开仓（带/不带止损）、撤单、只减仓、改杠杆、调限额、划转。提现插件永不实现').default(false),
}).description('Hyperliquid 交易台配置')

/**
 * @param ctx - the Cordis plugin context.
 * @param config - validated row config.
 */
export function apply(ctx, config = {}) {
  const remote = new HyperRemote(ctx, config)
  const disposers = []

  // Live channel lifecycle: stop the upstream WS on teardown.
  ctx.effect(() => () => remote.stopWs())

  // The persisted turn origin covers a plugin reload in the middle of an alert turn.
  const authorizeTurn = createTurnOriginGuard(ctx, {
    origin: { get: (sessionId) => remote.store.alertOrigin(sessionId), set: (sessionId, alert) => remote.store.setAlertOrigin(sessionId, alert) },
    canAutoTrade: (sessionId) => Boolean(sessionId && remote.store.getSession(sessionId) && remote.cfg.agentAutoTradeTestnet &&
      remote.cfg.tradingMode === 'live' && remote.isManaged()),
  })

  // Agent tools (optional service — degrade gracefully).
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  if (tools && typeof tools.register === 'function') {
    for (const def of buildToolDefinitions(remote, authorizeTurn)) {
      const remove = tools.register(def)
      disposers.push(remove)
      ctx.effect(() => () => { try { remove() } catch { /* already gone */ } })
    }
  } else {
    ctx.logger?.warn?.('[dsh-hyperliquid] tools 服务不可用，仅提供 UI 远端')
  }

  // Price alerts wake the owning session's agent (notify-only; guard rails live in lib/wake.js).
  if (config?.wakeAgentOnAlert !== false && typeof ctx?.get === 'function') {
    const waker = createAgentWaker({
      deliver: async (sessionId, text, { signal }) => {
        if (signal.aborted) return false
        // Resolved at delivery time: optional services may register after this plugin applies.
        const sessionController = ctx.get('sessionController')
        if (typeof sessionController?.resolveAgent !== 'function') return false
        const resolved = await sessionController.resolveAgent(sessionId)
        if (signal.aborted || !resolved || 'error' in resolved || typeof resolved.agent?.followup !== 'function') return false
        // Same shape as dsh-llm createUserMessage: an identified, frozen user-role message with its producer.
        // Mark the session before delivering: the turn this starts is an alert turn even if we reload mid-way.
        remote.store.setAlertOrigin(sessionId, true)
        resolved.agent.followup(deepFreeze({ role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-hyperliquid', form: 'event' } }))
        if (!signal.aborted) await ctx.get('sessions')?.flush?.(resolved.agent.session)
        return true
      },
    })
    const onAlert = (event) => { waker.notify(event) }
    remote.alertListeners.add(onAlert)
    ctx.effect(() => () => { remote.alertListeners.delete(onAlert); waker.dispose() })
  }

  // A closed 15m bar is the AI's decision checkpoint. It is independent of the
  // hourly scheduler and is enabled only for explicitly configured testnet autonomy.
  if (remote.cfg.agentAutoTradeTestnet && typeof ctx?.get === 'function') {
    const waker = createAgentWaker({
      debounceMs: 1_000, cooldownMs: 60_000, staleMs: 2 * 60_000, describe: marketBarWakeText,
      deliver: async (sessionId, message, { signal }) => {
        if (signal.aborted) return false
        const resolved = await ctx.get('sessionController')?.resolveAgent?.(sessionId)
        if (signal.aborted || !resolved || 'error' in resolved || typeof resolved.agent?.followup !== 'function') return false
        remote.store.setAlertOrigin(sessionId, true)
        resolved.agent.followup(deepFreeze({ role: 'user', id: randomUUID(), content: [{ type: 'text', text: message }],
          source: { kind: 'plugin:dsh-hyperliquid', form: 'market-bar' } }))
        if (!signal.aborted) await ctx.get('sessions')?.flush?.(resolved.agent.session)
        return true
      },
    })
    const monitor = createStrategyBarMonitor(remote, { notify: (event) => waker.notify(event) })
    const timer = setInterval(() => { void monitor.check().catch((error) => ctx.logger?.warn?.('[dsh-hyperliquid] strategy monitor', error)) }, 15_000)
    timer.unref?.()
    void monitor.check().catch((error) => ctx.logger?.warn?.('[dsh-hyperliquid] strategy monitor', error))
    ctx.effect(() => () => { clearInterval(timer); monitor.dispose(); waker.dispose() })
  }

  const skillRemove = registerHyperSkill(typeof ctx?.get === 'function' ? ctx.get('skills') : null)
  if (skillRemove) {
    disposers.push(skillRemove)
    ctx.effect(() => () => { try { skillRemove() } catch { /* already gone */ } })
  }

  // System-prompt section: make the desk discoverable to every agent, with
  // LIVE desk context (what the user is looking at right now) evaluated per
  // prompt — the desk and the conversation stay in lockstep both ways.
  const systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    const remove = systemPrompt.section({
      name: 'hyperliquid-desk',
      order: 500,
      // Fixed core + state the code computes (first meeting, unprotected position, losing streak); see lib/prompt.js.
      text: () => deskPrompt(remote, { skillLoaded: Boolean(skillRemove) }),
    })
    disposers.push(remove)
  }

  return () => {
    for (const d of disposers) {
      try { d() } catch { /* best effort */ }
    }
    remote.stopWs()
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
