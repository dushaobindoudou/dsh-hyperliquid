/** Register the packaged trading skill in DSH's native skill catalog. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const skillUrl = new URL('../skills/hyperliquid-trading/SKILL.md', import.meta.url)
const source = readFileSync(skillUrl, 'utf8')
const content = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()

export function registerHyperSkill(skills) {
  if (typeof skills?.register !== 'function') return null
  return skills.register({
    name: 'hyperliquid-trading',
    description: '交易副手：用 Hyperliquid 实时数据分析、规划、执行、对账与复盘，积累和迭代交易员的策略库；说明可交易市场、白名单、HIP-3 保证金等能力边界。',
    whenToUse: '讨论当前交易台、Hyperliquid 市场、持仓、订单、策略、复盘、paper 或 testnet/live 交易时使用。',
    source: 'bundled',
    path: fileURLToPath(skillUrl),
    content,
  })
}
