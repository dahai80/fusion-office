import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { destinationPage } from '../src/outline.js';

it.each([false, true])(
  'rejects out-of-range destinations returned by PDF.js (named=%s)',
  async (named) => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([200, 200]);
    if (named) doc.catalog.set(PDFName.of('Dests'), doc.context.obj({ missing: [3, 'Fit'] }));
    doc.getPage(0).node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 100, 40],
          Dest: named ? PDFString.of('missing') : [3, 'Fit'],
        }),
      ),
    );
    const task = pdfjs.getDocument({ data: await doc.save() });
    try {
      const pdf = await task.promise;
      const [link] = await (await pdf.getPage(1)).getAnnotations();
      expect(link.dest).toBeDefined();
      expect(await destinationPage(pdf, link.dest)).toBeNull();
      expect(await destinationPage(pdf, [0, { name: 'Fit' }])).toBe(0);
      expect(await destinationPage(pdf, [2, { name: 'Fit' }])).toBe(2);
      expect(
        await destinationPage(pdf, [
          { num: doc.getPage(2).ref.objectNumber, gen: 0 },
          { name: 'Fit' },
        ]),
      ).toBe(2);
    } finally {
      await task.destroy();
    }
  },
);

it.each([-1, 3, 999, 1.5, NaN, '2', undefined])('rejects invalid page index %s', async (index) => {
  expect(await destinationPage({ numPages: 3 }, [index, { name: 'Fit' }])).toBeNull();
});
