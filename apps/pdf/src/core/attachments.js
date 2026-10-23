import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFString,
  PDFHexString,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';

const name = PDFName.of;
/** Attached files are capped like inserted pictures, so one cannot exhaust the editor. */
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

const text = (value) =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';

/** The EmbeddedFiles name tree, or null when the document has none. */
function embeddedFiles(doc) {
  const names = doc.catalog.lookupMaybe(name('Names'), PDFDict);
  return names?.lookupMaybe(name('EmbeddedFiles'), PDFDict) || null;
}

/** Walk a name tree's leaves as [key, value, the Names array, index] in tree order. */
function* leaves(doc, node, seen = new Set()) {
  if (!(node instanceof PDFDict) || seen.has(node) || seen.size > 10000) return;
  seen.add(node);
  const entries = node.lookupMaybe(name('Names'), PDFArray);
  if (entries)
    for (let i = 0; i + 1 < entries.size(); i += 2)
      yield [text(entries.lookup(i)), entries.get(i + 1), entries, i];
  const kids = node.lookupMaybe(name('Kids'), PDFArray);
  if (kids) for (let i = 0; i < kids.size(); i++) yield* leaves(doc, kids.lookup(i), seen);
}

/** The document-level attachments: { key, name, description, size }. */
export function listAttachments(doc) {
  const tree = embeddedFiles(doc);
  if (!tree) return [];
  return [...leaves(doc, tree)].map(([key, value]) => {
    const spec = doc.context.lookup(value);
    const fileName =
      (spec instanceof PDFDict &&
        (text(spec.lookup(name('UF'))) || text(spec.lookup(name('F'))))) ||
      key;
    const stream =
      spec instanceof PDFDict && spec.lookupMaybe(name('EF'), PDFDict)?.lookup(name('F'));
    const params = stream?.dict?.lookupMaybe?.(name('Params'), PDFDict);
    const size = params?.lookup(name('Size'))?.asNumber?.();
    return {
      key,
      name: fileName,
      description: spec instanceof PDFDict ? text(spec.lookup(name('Desc'))) : '',
      size: Number.isFinite(size) ? size : null,
    };
  });
}

/** The bytes of a document-level attachment, decoded, or null when it cannot be read. */
export function attachmentBytes(doc, key) {
  const tree = embeddedFiles(doc);
  if (!tree) return null;
  for (const [entryKey, value] of leaves(doc, tree)) {
    if (entryKey !== key) continue;
    const spec = doc.context.lookup(value);
    const stream =
      spec instanceof PDFDict && spec.lookupMaybe(name('EF'), PDFDict)?.lookup(name('F'));
    if (!(stream instanceof PDFRawStream)) return null;
    try {
      return decodePDFRawStream(stream).decode();
    } catch {
      return null;
    }
  }
  return null;
}

/** Attach a file to the document, as a desktop editor's Attachments panel does. */
export async function addAttachment(doc, { name: fileName, bytes, mimeType, description = '' }) {
  if (!fileName) throw new Error('Choose a file to attach.');
  if (bytes.length > MAX_ATTACHMENT_SIZE) throw new Error('Attach files of up to 20 MB.');
  const taken = new Set(listAttachments(doc).map((entry) => entry.key));
  // pdf-lib keys attachments by name; a second file of the same name gets a numbered key.
  let key = fileName;
  for (let n = 2; taken.has(key); n++) key = fileName.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  await doc.attach(bytes, key, {
    mimeType: mimeType || 'application/octet-stream',
    description,
    creationDate: new Date(),
    modificationDate: new Date(),
  });
  return key;
}

/** Remove a document-level attachment by its name tree key. False when it was not found. */
export function removeAttachment(doc, key) {
  const tree = embeddedFiles(doc);
  if (!tree) return false;
  for (const [entryKey, , entries, index] of leaves(doc, tree)) {
    if (entryKey !== key) continue;
    // The leaf's Limits still bound the remaining keys, so they stay valid as they are.
    entries.remove(index + 1);
    entries.remove(index);
    return true;
  }
  return false;
}
