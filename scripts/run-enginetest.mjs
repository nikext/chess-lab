/**
 * Drives /enginetest.html in headless Chromium and prints its report.
 * Exits non-zero if any check failed, so it works in a pre-commit hook or CI.
 * Requires the dev server (npm run dev) to already be listening.
 */
import { chromium } from 'playwright'

// Vite may bind v6-only, so try both loopback families rather than trusting
// whatever `localhost` happens to resolve to.
const CANDIDATES = process.env.ENGINETEST_URL
  ? [process.env.ENGINETEST_URL]
  : ['http://127.0.0.1:5183/enginetest.html', 'http://[::1]:5183/enginetest.html']

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.error('  [console]', m.text()) })
page.on('pageerror', (e) => console.error('  [pageerror]', e.message))

let loaded = false
for (const url of CANDIDATES) {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 20000 })
    loaded = true
    break
  } catch { /* try the next address */ }
}
if (!loaded) {
  console.error(`Could not reach the dev server. Tried:\n  ${CANDIDATES.join('\n  ')}\nRun "npm run dev" first.`)
  await browser.close()
  process.exit(2)
}
await page.waitForFunction(() => window.__enginetest !== undefined, null, { timeout: 300_000 })

// Read the report and the verdict in one shot: Vite's HMR can push an update
// between two evaluates and destroy the execution context.
const { report, failures } = await page.evaluate(() => ({
  report: document.getElementById('out').textContent,
  failures: window.__enginetest.failures,
}))
console.log(report)
await browser.close()
process.exit(failures === 0 ? 0 : 1)
