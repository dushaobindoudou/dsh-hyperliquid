# dsh-hyperliquid 项目长期记忆

## 官方品牌素材（icon 唯一来源）
- 品牌包：https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit —— "Hyperliquid SVG format.zip"（14KB，7 个官方矢量：Blob_Green `#97fce4` / Blob_Dark `#011916` / Blob_Light `#fff` 三色 mark，200×200；Dark/Light 完整锁定版 856×200；Type_Dark/Light 字标 664×200）。
- 页面 JS 渲染：`curl -A "<browser UA>"` 抓 HTML，grep `gitbook-x-prod.appspot.com` 直链；直链默认返回 JSON 元数据，需拼 `?alt=media&token=<downloadTokens>` 才下到 zip。
- **仓库铁律：只用 SVG，零光栅图片**（glob 实证）。当前采用：`icon.svg` = 官方 Blob_Green + 官方 `#011916` 底板；client.js `BrandMark` = 官方路径 viewBox 200×200。
- 品牌规范：不得重配色/拉伸/旋转/描边/加效果；mark 是单闭合路径。
- 历史更正：早期调研（docs/research-hyperliquid-logo-and-trade-ui.md）曾结论「官方无 SVG」，已在该文档内更新为品牌包发现记录。

## 测试
- `npm test` = signing（官方 SDK 三向量）+ store（paper 撮合 10 组）+ markers（静态契约：client.js 的 hyperCall 方法必须都在 remote.js marker 列表中，防 deskState 式静默失败）。

## 已修 bug（2026-10-13）
1. deskState 缺 Remote marker（UI 切币不同步宿主）
2. paper 平仓盈亏符号反（`usd -= realized`）
3. 部分平仓把收盘价混进剩余持仓均价（已实现+浮动盈亏重复计算）
4. live 下单补最小名义价值 $10 校验
