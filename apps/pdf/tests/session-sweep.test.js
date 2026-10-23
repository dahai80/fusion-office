import { expect, it } from 'vitest';
import { PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { PdfSession } from '../src/core/document.js';
import { setPageSource } from '../src/core/text-edit.js';

async function twoPages() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Public page', { x: 20, y: 200, size: 12, font });
  doc.addPage([300, 300]).drawText('SECRET page', { x: 20, y: 200, size: 12, font });
  return new PdfSession(await doc.save({ useObjectStreams: false }));
}
/** Whether any stream of the saved file, decoded, still holds `text` (as drawn, in hex). */
async function contains(bytes, text) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const wanted = Buffer.from(text).toString('hex').toUpperCase();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const data = Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
    if (data.includes(wanted)) return true;
  }
  return false;
}

it('leaves no trace of a deleted page in the saved file', async () => {
  const session = await twoPages();
  expect(await contains(session.bytes, 'SECRET page')).toBe(true);
  await session.change((doc) => doc.removePage(1));
  expect(await contains(session.bytes, 'SECRET page')).toBe(false);
  expect(await contains(session.bytes, 'Public page')).toBe(true);
});

it('does not keep replaced page content as the PDF is edited again and again', async () => {
  const session = await twoPages();
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    await session.change((doc) =>
      setPageSource(doc, doc.getPage(0), `BT /F1 12 Tf 20 ${100 + i} Td (Edit ${i}) Tj ET`),
    );
    sizes.push(session.bytes.length);
  }
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
});
