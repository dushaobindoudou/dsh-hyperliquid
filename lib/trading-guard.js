import { randomUUID } from 'node:crypto'
import { coinAllowed } from './risk-settings.js'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TTL_MS = 30_000

/** Server-only, one-use trade plans and conservative durable daily budgets. */
export class TradingGuard {
  constructor(dataDir, limits, { budgetName = 'live-budget.json' } = {}) {
    this.limits = limits
    this.plans = new Map()
    this.budgetFile = join(dataDir, budgetName)
    this.budget = existsSync(this.budgetFile)
      ? JSON.parse(readFileSync(this.budgetFile, 'utf8'))
      : { day: '', usedUsd: 0 }
    if (typeof this.budget.day !== 'string' || !Number.isFinite(this.budget.usedUsd) || this.budget.usedUsd < 0) {
      throw new Error('live 交易额度账本损坏，拒绝启动')
    }
  }

  validate({ coin, isBuy, sz, price, positionSize, otherExposureUsd = 0, accountValue, leverage, reduceOnly }) {
    const l = this.limits
    if (typeof isBuy !== 'boolean' || !Number.isFinite(sz) || sz <= 0 || !Number.isFinite(price) || price <= 0) throw new Error('订单方向、数量或价格无效')
    if (!Number.isFinite(accountValue) || !Number.isFinite(otherExposureUsd) || otherExposureUsd < 0) throw new Error('无法验证账户权益/敞口，拒绝下单')
    if (!Number.isFinite(positionSize) || !Number.isFinite(leverage) || leverage < 1) throw new Error('持仓或杠杆超出交易权限')
    const signed = (isBuy ? 1 : -1) * sz
    const nextSize = positionSize + signed
    if (reduceOnly && (positionSize === 0 || Math.sign(signed) === Math.sign(positionSize) || sz > Math.abs(positionSize) + 1e-10)) throw new Error('只减仓订单会增加或翻转仓位')
    const riskReducing = positionSize !== 0 && Math.sign(signed) !== Math.sign(positionSize) &&
      (nextSize === 0 || Math.sign(nextSize) === Math.sign(positionSize)) && Math.abs(nextSize) < Math.abs(positionSize)
    if (!riskReducing && !coinAllowed(l.allowedCoins, coin)) throw new Error(`交易限额：${coin} 不在允许交易币对内（allowedCoins）`)
    if (!riskReducing && leverage > l.maxLeverage) throw new Error(`交易限额：杠杆 ${leverage}x 超过上限 ${l.maxLeverage}x（maxLeverage）`)
    const notionalUsd = sz * price
    if (!riskReducing && accountValue <= 0) throw new Error('账户权益不足，拒绝开仓')
    if (!riskReducing && notionalUsd > l.maxOrderUsd) throw new Error(`交易限额：单笔名义价值 ${notionalUsd.toFixed(2)} 超过上限 ${l.maxOrderUsd} USD（maxOrderUsd）`)
    if (!riskReducing && Math.abs(nextSize) * price > l.maxPositionUsd) throw new Error(`交易限额：执行后 ${coin} 仓位超过 ${l.maxPositionUsd} USD（maxPositionUsd）`)
    if (!riskReducing && Math.abs(nextSize) * price > accountValue * l.maxLeverage) throw new Error('执行后仓位超过权益允许的杠杆敞口')
    if (!riskReducing && otherExposureUsd + Math.abs(nextSize) * price > accountValue * l.maxLeverage) throw new Error('执行后全账户敞口超过权益允许的杠杆倍数')
    this.rollDay()
    if (!riskReducing && this.budget.usedUsd + notionalUsd > l.maxDailyUsd) throw new Error(`交易限额：今日下单额将超过 ${l.maxDailyUsd} USD（maxDailyUsd，UTC 日重置）`)
    return { notionalUsd, nextSize, riskReducing }
  }

  rollDay() {
    const day = new Date().toISOString().slice(0, 10)
    if (this.budget.day !== day) this.budget = { day, usedUsd: 0 }
  }

  create(order, sessionId, preview) {
    const id = randomUUID()
    this.plans.set(id, { order, sessionId, preview, expiresAt: Date.now() + TTL_MS })
    for (const [key, plan] of this.plans) if (plan.expiresAt <= Date.now()) this.plans.delete(key)
    return { decisionId: id, expiresAt: Date.now() + TTL_MS, ...preview }
  }

  consume(id, order, sessionId) {
    const plan = this.plans.get(id)
    this.plans.delete(id)
    if (!plan || plan.expiresAt <= Date.now()) throw new Error('交易决策已失效，请重新预检')
    if (plan.sessionId !== sessionId || JSON.stringify(plan.order) !== JSON.stringify(order)) throw new Error('订单与预检决策不一致')
    return plan.preview
  }

  reserve(notionalUsd, { riskReducing = false } = {}) {
    this.rollDay()
    if (riskReducing) return { day: this.budget.day, notionalUsd: 0 }
    if (this.budget.usedUsd + notionalUsd > this.limits.maxDailyUsd) throw new Error('交易限额：今日下单额度已耗尽（maxDailyUsd，UTC 日重置）')
    this.budget.usedUsd += notionalUsd
    mkdirSync(this.limits.dataDir, { recursive: true })
    const tmp = this.budgetFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.budget), { mode: 0o600 })
    renameSync(tmp, this.budgetFile)
    return { day: this.budget.day, notionalUsd }
  }

  /** Return quota only when the exchange definitively rejected the action. */
  release(ticket) {
    this.rollDay()
    if (!ticket || ticket.day !== this.budget.day) return
    this.budget.usedUsd = Math.max(0, this.budget.usedUsd - ticket.notionalUsd)
    mkdirSync(this.limits.dataDir, { recursive: true })
    const tmp = this.budgetFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.budget), { mode: 0o600 })
    renameSync(tmp, this.budgetFile)
  }
}
