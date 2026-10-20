/**
 * dsh-hyperliquid — locale dictionaries (zh/en), registered through the
 * shell `locale` service under the plugin namespace.
 * @module src/client/locale
 */

export const NS = 'dsh-hyperliquid'

export const DICT = {
  zh: {
    'app.title': 'Hyperliquid 交易台', 'app.suffix': '交易台',
    'sessions.title': '交易会话', 'sessions.new': '新建交易会话', 'sessions.empty': '还没有交易会话。\n点击上方新建，开一个专属交易对话。', 'session.createFailed': '创建交易会话失败',
    'book.title': '盘口', 'book.waiting': '等待上游行情…', 'book.clickHint': '填入交易票据', 'book.price': '价格', 'book.size': '数量', 'book.total': '累计', 'book.spread': '价差', 'trades.title': '最近成交',
    'tab.positions': '持仓', 'tab.orders': '委托与成交', 'tab.account': '账户',
    'orders.coin': '合约', 'orders.side': '方向', 'orders.px': '价格', 'orders.sz': '数量', 'orders.status': '状态', 'orders.none': '（暂无委托与成交）', 'orders.open': '挂单中',
    'side.buy': '买', 'side.sell': '卖',
    'desk.oracle': '预言机', 'desk.annualized': '年化：',
    'positions.title': '持仓与成交', 'positions.coin': '合约', 'positions.size': '数量', 'positions.entry': '开仓价', 'positions.mark': '标记', 'positions.upnl': '未实现', 'positions.none': '（无持仓）',
    'account.cash': '现金', 'account.equity': '权益', 'account.value': '账户价值', 'account.available': '可用', 'account.none': '未连接钱包',
    'banner.title': '会话驱动交易', 'banner.body': '在右侧会话中讨论行情、风险与交易决策；盘口价格可用于辅助填写票据。',
    'desk.vol': '24h成交', 'desk.funding': '资金费', 'chart.loading': 'K 线加载中…',
    'desk.noSession': '先在左侧选择一个交易会话', 'desk.queued': '已把请求送入交易会话，agent 将核对后处理',
    'chat.title': '交易会话', 'chat.noSession': '选择左侧交易会话，\n在这里直接与交易 agent 对话。', 'chat.linking': '正在接入会话…', 'chat.ticket': '交易票据', 'chat.back': '返回会话', 'chat.prompts': '快捷提问', 'chat.analyze': '分析行情', 'chat.risk': '检查风险',
    'chat.bindError': '会话绑定失败：', 'chat.noFactory': '原生会话组件不可用（renderer kit 缺失）。', 'chat.upgrade': '当前 DSH 版本不支持嵌入原生会话；请使用 DSH 0.2 或更新版本。',
    'mode.paper': '模拟盘', 'mode.live': '实盘', 'status.unavailable': '远端不可用',
    'status.online': '在线', 'status.offline': '离线',
    'session.defaultTitle': 'Hyperliquid 交易会话', 'session.rename': '重命名', 'session.name': '会话名称', 'session.archive': '归档', 'session.renameFailed': '重命名失败', 'session.archiveFailed': '归档会话失败',
    'modal.close': '关闭', 'modal.cancel': '取消', 'modal.save': '保存',
    'network.label': '网络', 'network.testnet': '测试网', 'network.mainnet': '主网', 'network.switchFailed': '切换网络失败', 'network.confirmTitle': '切换到主网', 'network.confirmBody': '主网会显示真实行情和账户；实盘模式下，后续交易将使用真实资金。', 'network.confirm': '切换主网',
    'language.label': '语言', 'theme.label': '主题', 'theme.system': '跟随系统', 'theme.light': '浅色', 'theme.dark': '深色',
    'market.choose': '选择市场', 'market.search': '搜索市场', 'market.tradable': '可交易', 'market.all': '全部', 'market.name': '市场', 'market.price': '最新价', 'market.change': '24h 涨跌', 'market.funding': '资金费', 'market.volume': '24h 成交额', 'market.openInterest': '未平仓量', 'market.outcomeTestnet': 'Outcome 目录目前仅在 testnet 提供。', 'market.empty': '没有匹配的市场', 'market.loading': '正在读取市场目录…', 'market.shortcuts': '↑↓ 选择　Enter 打开　⌘/Ctrl+S 自选　Esc 关闭', 'market.count': '个市场',
    'market.category.all': '全部', 'market.category.perp': '永续', 'market.category.spot': '现货', 'market.category.hip3': 'HIP-3', 'market.category.outcome': 'Outcome', 'market.category.crypto': 'Crypto', 'market.category.tradfi': 'TradFi', 'market.category.preipo': 'Pre-IPO', 'market.category.trending': '热门', 'market.category.favorites': '自选',
    'time.now': '刚刚',
    'error.noConnection': '无连接', 'error.callFailed': '远端调用失败', 'error.badResponse': '远端响应格式错误',
  },
  en: {
    'app.title': 'Hyperliquid Desk', 'app.suffix': 'Desk',
    'sessions.title': 'Trading sessions', 'sessions.new': 'New trading session', 'sessions.empty': 'No trading sessions yet.\nCreate one to start a trading chat.', 'session.createFailed': 'Failed to create session',
    'book.title': 'Order book', 'book.waiting': 'Waiting for upstream data…', 'book.clickHint': 'Fill the trade ticket', 'book.price': 'Price', 'book.size': 'Size', 'book.total': 'Total', 'book.spread': 'Spread', 'trades.title': 'Recent trades',
    'tab.positions': 'Positions', 'tab.orders': 'Orders & fills', 'tab.account': 'Account',
    'orders.coin': 'Coin', 'orders.side': 'Side', 'orders.px': 'Price', 'orders.sz': 'Size', 'orders.status': 'Status', 'orders.none': '(no orders or fills yet)', 'orders.open': 'resting',
    'side.buy': 'Buy', 'side.sell': 'Sell',
    'desk.oracle': 'Oracle', 'desk.annualized': 'Annualized: ',
    'positions.title': 'Positions & fills', 'positions.coin': 'Coin', 'positions.size': 'Size', 'positions.entry': 'Entry', 'positions.mark': 'Mark', 'positions.upnl': 'uPnL', 'positions.none': '(no positions)',
    'account.cash': 'Cash', 'account.equity': 'Equity', 'account.value': 'Account value', 'account.available': 'Available', 'account.none': 'No wallet',
    'banner.title': 'Session-led trading', 'banner.body': 'Discuss the market, risk and trade decisions in the conversation. Book prices can help fill the ticket.',
    'desk.vol': '24h vol', 'desk.funding': 'Funding', 'chart.loading': 'Loading candles…',
    'desk.noSession': 'Pick a trading session on the left', 'desk.queued': 'Request sent to the trading chat for agent review',
    'chat.title': 'Trading chat', 'chat.noSession': 'Pick a trading session on the left,\nthen discuss trades with the agent here.', 'chat.linking': 'Linking session…', 'chat.ticket': 'Trade ticket', 'chat.back': 'Back to chat', 'chat.prompts': 'Quick prompts', 'chat.analyze': 'Analyze market', 'chat.risk': 'Check risk',
    'chat.bindError': 'Session binding failed: ', 'chat.noFactory': 'Native conversation unavailable (renderer kit missing).', 'chat.upgrade': 'This DSH version cannot embed native chat. Use DSH 0.2 or newer.',
    'mode.paper': 'PAPER', 'mode.live': 'LIVE', 'status.unavailable': 'Host offline',
    'status.online': 'Online', 'status.offline': 'Offline',
    'session.defaultTitle': 'Hyperliquid trading session', 'session.rename': 'Rename', 'session.name': 'Session name', 'session.archive': 'Archive', 'session.renameFailed': 'Rename failed', 'session.archiveFailed': 'Could not archive session',
    'modal.close': 'Close', 'modal.cancel': 'Cancel', 'modal.save': 'Save',
    'network.label': 'Network', 'network.testnet': 'Testnet', 'network.mainnet': 'Mainnet', 'network.switchFailed': 'Could not switch network', 'network.confirmTitle': 'Switch to mainnet', 'network.confirmBody': 'Mainnet displays real market and account data. In live mode, subsequent trades use real funds.', 'network.confirm': 'Switch to mainnet',
    'language.label': 'Language', 'theme.label': 'Theme', 'theme.system': 'System', 'theme.light': 'Light', 'theme.dark': 'Dark',
    'market.choose': 'Choose market', 'market.search': 'Search markets', 'market.tradable': 'Tradable', 'market.all': 'All', 'market.name': 'Market', 'market.price': 'Last price', 'market.change': '24h change', 'market.funding': 'Funding', 'market.volume': '24h volume', 'market.openInterest': 'Open interest', 'market.outcomeTestnet': 'Outcome markets are currently available on testnet only.', 'market.empty': 'No matching markets', 'market.loading': 'Loading market catalog…', 'market.shortcuts': '↑↓ Select   Enter Open   ⌘/Ctrl+S Favorite   Esc Close', 'market.count': 'markets',
    'market.category.all': 'All', 'market.category.perp': 'Perps', 'market.category.spot': 'Spot', 'market.category.hip3': 'HIP-3', 'market.category.outcome': 'Outcome', 'market.category.crypto': 'Crypto', 'market.category.tradfi': 'TradFi', 'market.category.preipo': 'Pre-IPO', 'market.category.trending': 'Trending', 'market.category.favorites': 'Favorites',
    'time.now': 'now',
    'error.noConnection': 'No connection', 'error.callFailed': 'RPC failed', 'error.badResponse': 'Bad response',
  },
}
