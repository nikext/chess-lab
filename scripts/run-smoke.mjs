/**
 * End-to-end smoke test for the app itself: does Stockfish actually boot in
 * the browser, do analysis lines and arrows appear, and does the Jev panel
 * fail gracefully when no API key is configured?
 * Requires the dev server (npm run dev) to already be listening.
 */
import { chromium } from 'playwright'

const CANDIDATES = process.env.SMOKE_URL
  ? [process.env.SMOKE_URL]
  : ['http://127.0.0.1:5183/', 'http://[::1]:5183/']

const browser = await chromium.launch()
const page = await browser.newPage()

const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

let loaded = false
for (const url of CANDIDATES) {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 20000 })
    loaded = true
    break
  } catch { /* try the next address */ }
}
if (!loaded) {
  console.error('Could not reach the dev server. Run "npm run dev" first.')
  await browser.close()
  process.exit(2)
}

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('App smoke test\n\n[1] analyse tab')
await page.waitForSelector('.board-area', { timeout: 20000 })
check('board renders', true)

// Stockfish boots as a WASM worker; give it room on a cold start.
await page.waitForSelector('.line-row', { timeout: 90000 })
await page.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="engine-depth"]')
    const m = el && el.textContent.match(/depth (\d+)/)
    return !!m && Number(m[1]) >= 12
  },
  null,
  { timeout: 90000 },
)
const depthText = (await page.getAttribute('[data-testid="engine-depth"]', 'textContent')) ?? await page.textContent('[data-testid="engine-depth"]')
check('stockfish reaches a real search depth', true, depthText.trim())

const lineCount = await page.locator('.line-row').count()
check('stockfish returns multipv lines', lineCount >= 2, `${lineCount} lines`)

const firstScore = await page.locator('.line-row .score').first().textContent()
check('first line has an evaluation', /^[+#-]/.test(firstScore.trim()), firstScore.trim())

const firstPv = await page.locator('.line-row .pv b').first().textContent()
check('first line has a principal variation', firstPv.trim().length > 0, firstPv.trim())

const arrows = await page.locator('.board-area svg line, .board-area svg polygon, .board-area svg path').count()
check('arrows drawn on the board', arrows > 0, `${arrows} svg marks`)

console.log('\n[2] jev panel')

const jevText = () =>
  page.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')]
      .find((el) => el.querySelector('h2')?.textContent?.includes('Jev'))
    return panel ? panel.textContent : ''
  })

// Settle either way: a real reading when a key is configured, a clear message
// when one is not. Both are correct behaviour; neither may be a blank panel.
await page
  .waitForFunction(
    () => {
      const panel = [...document.querySelectorAll('.panel')]
        .find((el) => el.querySelector('h2')?.textContent?.includes('Jev'))
      const t = panel ? panel.textContent : ''
      return /JEV_API_KEY|Jev:/.test(t) || /confident/.test(t)
    },
    null,
    { timeout: 60000 },
  )
  .catch(() => {})

const jev = await jevText()
const hasKey = /confident/.test(jev)

if (hasKey) {
  console.log('  (a Jev API key is configured — checking the live reading)')
  check('renders a chosen move with a confidence', /confident/.test(jev), jev.match(/.{0,24}confident/)?.[0]?.trim())
  check('renders a positional read', /for White/.test(jev))
  check('renders the danger gauge', /Immediate danger/.test(jev))
  check('reports round-trip latency', /\d+\s*ms/.test(jev), jev.match(/\d+\s*ms/)?.[0])

  const bars = await page.locator('.bar-row .pct').allTextContents()
  const total = bars.reduce((s, t) => s + parseFloat(t), 0)
  check('move probabilities are a distribution', bars.length > 0 && total > 0 && total <= 100.5,
    `${bars.length} moves summing to ${total.toFixed(1)}%`)
} else {
  console.log('  (no Jev API key — checking the fallback path)')
  check('shows an actionable message rather than crashing', /JEV_API_KEY/.test(jev),
    jev.slice(0, 90))
}

console.log('\n[3] position changes refresh the analysis')

// Reading the board: engine arrows render as <polygon fill="<colour>">.
const DARK = '#1c7a43'   // best move
const LIGHT = '#7ed3a4'  // second best
const arrowColours = () =>
  page.evaluate(() => [...document.querySelectorAll('polygon[fill]')].map((e) => e.getAttribute('fill')))

const loadFen = async (fen) => {
  await page.fill('[data-testid="fen-input"]', fen)
  await page.click('[data-testid="fen-load"]')
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="engine-depth"]')
      const m = el && el.textContent.match(/depth (\d+)/)
      return !!m && Number(m[1]) >= 14
    },
    null,
    { timeout: 90000 },
  )
}

// A position where the engine must find a free pawn.
await loadFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 2')
let best = (await page.locator('.line-row .pv b').first().textContent()).trim()
let score = (await page.locator('.line-row .score').first().textContent()).trim()
check('finds the free pawn', best === 'Nxe5', `best=${best} score=${score}`)
check('evaluates it as winning material', parseFloat(score) >= 0.8, score)

let colours = await arrowColours()
check('draws exactly two engine arrows', colours.filter((c) => c === DARK || c === LIGHT).length === 2,
  `dark=${colours.filter((c) => c === DARK).length} light=${colours.filter((c) => c === LIGHT).length}`)
check('best and second best are the same hue, best darker',
  colours.includes(DARK) && colours.includes(LIGHT))

// Now a mate in one. Everything on screen must change.
await loadFen('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1')
best = (await page.locator('.line-row .pv b').first().textContent()).trim()
score = (await page.locator('.line-row .score').first().textContent()).trim()
check('finds mate in one after the position changes', best === 'Ra8#', `best=${best}`)
check('shows a mate score rather than centipawns', score === '#1', score)

const whiteHeight = await page.evaluate(
  () => document.querySelector('[data-testid="eval-white"]').style.height,
)
check('eval bar pins to a win for White on forced mate', whiteHeight === '100%', whiteHeight)

colours = await arrowColours()
const stale = colours.filter((c) => c === DARK || c === LIGHT).length
check('no arrows left over from the previous position', stale === 2, `${stale} engine arrows`)

console.log('\n[4] play tab')
await page.getByRole('tab', { name: 'Play Jev' }).click()
await page.waitForSelector('.movelist', { timeout: 10000 })
check('play tab renders', true)

console.log('\n[5] console health')
// The 503 from /api/jev is the no-key path that section 2 asserts on.
const realErrors = consoleErrors.filter(
  (e) => !/favicon|Failed to load resource.*(404|503)/i.test(e),
)
check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

const failures = checks.filter((c) => !c.ok).length
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
