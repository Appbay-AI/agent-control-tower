// Prints a real evidence-pack PDF in Node (pdfmake's Node build) and reads its text back with pdfjs (tasks 6.1, 6.2).
import { createRequire } from 'node:module'
import { buildEvidenceDoc, type EvidencePack } from '@/lib/evidence'

export async function pdfText(pack: EvidencePack): Promise<{ text: string; pages: number; bytes: number }> {
  const require = createRequire(import.meta.url)
  const pdfmake = require('pdfmake') // the Node build
  pdfmake.setFonts(require('pdfmake/fonts/Roboto.js'))
  const buf: Buffer = await pdfmake.createPdf(buildEvidenceDoc(pack)).getBuffer()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    text += (await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  return { text: text.replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1-$2'), pages: doc.numPages, bytes: buf.length }
}

