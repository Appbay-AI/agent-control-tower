// Prints plan.html to Agent_Control_Tower_Build_Plan.pdf with Chromium (Playwright).
// Run from the repo root after build.py:  node docs/build-plan/print.mjs
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const executablePath = process.env.CHROMIUM_PATH || undefined // e.g. /opt/pw-browsers/chromium in the Claude sandbox
const browser = await chromium.launch({ executablePath })
const page = await browser.newPage()
await page.goto(`file://${path.join(dir, 'plan.html')}`, { waitUntil: 'load' })
await page.pdf({
  path: path.join(dir, 'Agent_Control_Tower_Build_Plan.pdf'),
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div style="font-size:7pt;color:#666;width:100%;padding:0 14mm">Agent Control Tower — Build Plan</div>',
  footerTemplate: '<div style="font-size:7pt;color:#666;width:100%;padding:0 14mm;text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
})
await browser.close()
console.log('wrote', path.join(dir, 'Agent_Control_Tower_Build_Plan.pdf'))
