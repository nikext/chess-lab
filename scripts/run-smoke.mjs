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

console.log('\n[2] jev panel with no API key configured')
const notice = await page.locator('.panel .notice').allTextContents()
const graceful = notice.some((t) => /JEV_API_KEY/i.test(t))
check('shows an actionable message rather than crashing', graceful,
  notice.find((t) => /JEV_API_KEY/i.test(t))?.slice(0, 80) ?? notice.join(' | ').slice(0, 80))

console.log('\n[3] play tab')
await page.getByRole('tab', { name: 'Play Jev' }).click()
await page.waitForSelector('.movelist', { timeout: 10000 })
check('play tab renders', true)

console.log('\n[4] console health')
// The 503 from /api/jev is the no-key path that section 2 asserts on.
const realErrors = consoleErrors.filter(
  (e) => !/favicon|Failed to load resource.*(404|503)/i.test(e),
)
check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

const failures = checks.filter((c) => !c.ok).length
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
