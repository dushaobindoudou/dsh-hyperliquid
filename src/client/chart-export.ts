import type { IChartApi } from 'lightweight-charts'

/** Compose the chart canvas and its saved SVG drawings into an opaque PNG. */
export async function chartImage(chart: IChartApi, box: HTMLElement, title: string): Promise<Blob> {
  const source = chart.takeScreenshot()
  const scale = source.width / box.clientWidth
  const canvas = document.createElement('canvas')
  canvas.width = source.width; canvas.height = source.height + Math.round(30 * scale)
  const ctx = canvas.getContext('2d')!
  const theme = getComputedStyle(box)
  // Resolve the first painted ancestor, including light and dark shell themes.
  let background = '#151517'
  for (let node: HTMLElement | null = box; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break }
  }
  ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(source, 0, 30 * scale)
  const overlay = box.querySelector<SVGSVGElement>('.dhl-chart-drawing-overlay')
  if (overlay) {
    const clone = overlay.cloneNode(true) as SVGSVGElement
    const originals = [overlay, ...overlay.querySelectorAll<SVGElement>('*')]
    const copies = [clone, ...clone.querySelectorAll<SVGElement>('*')]
    originals.forEach((original, index) => {
      const css = getComputedStyle(original)
      for (const key of ['color', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'paint-order']) {
        copies[index].style.setProperty(key, css.getPropertyValue(key))
      }
    })
    // Editing handles and invisible hit targets are UI, not chart annotations.
    clone.querySelectorAll('.dhl-drawing-hit, .dhl-chart-anchor, .dhl-drawing-preview').forEach((node) => node.remove())
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(box.clientWidth)); clone.setAttribute('height', String(box.clientHeight))
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      ctx.drawImage(image, 0, 30 * scale, source.width, source.height)
    } finally { URL.revokeObjectURL(url) }
  }
  ctx.fillStyle = theme.color; ctx.font = `${11 * scale}px sans-serif`
  ctx.fillText(title, 10 * scale, 19 * scale)
  for (const selector of ['.dhl-chart-ohlc', '.dhl-chart-ma-legend', '.dhl-chart-study-legend']) {
    const element = box.querySelector<HTMLElement>(selector)
    if (!element) continue
    const rect = element.getBoundingClientRect(), base = box.getBoundingClientRect()
    ctx.font = `${10 * scale}px sans-serif`
    ctx.fillText(element.innerText.replaceAll('\n', '  '), (rect.left - base.left) * scale, (rect.top - base.top + 11 + 30) * scale, source.width - 24 * scale)
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG export failed')), 'image/png'))
}
