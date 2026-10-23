/**
 * Bookmarks (the PDF outline): add one for a page, rename one, or remove one. Items are
 * addressed by their path of indices in the tree, the same order PDF.js reports them in.
 */
import { PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef } from 'pdf-lib';

const name = PDFName.of;
export const MAX_BOOKMARK_TITLE = 200;

function outlines(doc, create = false) {
  const catalog = doc.catalog;
  let ref = catalog.get(name('Outlines'));
  let dict = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
  if (!(dict instanceof PDFDict)) {
    if (!create) return null;
    dict = doc.context.obj({ Type: 'Outlines', Count: 0 });
    ref = doc.context.register(dict);
    catalog.set(name('Outlines'), ref);
  } else if (!(ref instanceof PDFRef)) {
    // Items point back at the root through Parent, which must be a reference; a root some
    // writers put straight into the catalog becomes an indirect object first.
    ref = doc.context.register(dict);
    catalog.set(name('Outlines'), ref);
  }
  return { ref, dict };
}
/** A node's children in order, as [ref, dict] pairs; a broken chain ends the list. */
function children(doc, node) {
  const list = [];
  const seen = new Set();
  let ref = node.get(name('First'));
  while (ref instanceof PDFRef && !seen.has(ref.toString())) {
    seen.add(ref.toString());
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) break;
    list.push([ref, dict]);
    ref = dict.get(name('Next'));
  }
  return list;
}
/** Walk `path` from the root; returns the item and its parent, or null. */
function locate(doc, path) {
  const root = outlines(doc);
  if (!root || !Array.isArray(path) || !path.length) return null;
  let parentRef = root.ref,
    parentDict = root.dict;
  for (let depth = 0; depth < path.length; depth++) {
    const list = children(doc, parentDict);
    const hit = list[path[depth]];
    if (!hit) return null;
    if (depth === path.length - 1) {
      const index = Number(path[depth]);
      return {
        ref: hit[0],
        dict: hit[1],
        parentRef,
        parentDict,
        previous: list[index - 1],
        following: list[index + 1],
      };
    }
    [parentRef, parentDict] = hit;
  }
  return null;
}
/**
 * Set every Count: the root counts all items shown when everything is open, an item counts
 * its shown descendants, negative when it is closed. Returns the signed count of `node`.
 */
function recount(doc, node, isRoot) {
  // Imported outlines can be much deeper than the JavaScript call stack. Process each
  // node after its children with explicit frames, retaining the cycle guard and counts.
  const seen = new Set();
  const stack = [{ node, isRoot }];
  while (stack.length) {
    const frame = stack.at(-1);
    if (!frame.kids) {
      frame.kids = children(doc, frame.node).filter(([ref]) => !seen.has(ref.toString()));
      for (const [ref] of frame.kids) seen.add(ref.toString());
      frame.total = frame.kids.length;
      frame.next = 0;
    }
    if (frame.next < frame.kids.length) {
      stack.push({ node: frame.kids[frame.next++][1], isRoot: false });
      continue;
    }
    let count = frame.total;
    if (!frame.isRoot && !frame.kids.length) frame.node.delete(name('Count'));
    else {
      const closed = !frame.isRoot && (frame.node.lookup(name('Count'))?.asNumber?.() ?? -1) < 0;
      if (closed) count = -count;
      frame.node.set(name('Count'), PDFNumber.of(count));
    }
    stack.pop();
    if (!stack.length) return count;
    if (count > 0) stack.at(-1).total += count;
  }
}
function checkTitle(title) {
  const text = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('Enter a name for the bookmark.');
  if (text.length > MAX_BOOKMARK_TITLE)
    throw new Error(`Keep the bookmark name under ${MAX_BOOKMARK_TITLE} characters.`);
  return text;
}

/** Append a top-level bookmark that opens `pageIndex`. Returns its path. */
export function addBookmark(doc, { title, pageIndex }) {
  const text = checkTitle(title);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount())
    throw new Error('Choose a page for the bookmark.');
  const root = outlines(doc, true);
  const item = doc.context.obj({
    Title: PDFHexString.fromText(text),
    Parent: root.ref,
    Dest: [doc.getPage(pageIndex).ref, 'Fit'],
  });
  const itemRef = doc.context.register(item);
  // Readers follow First/Next; an absent or stale Last must not detach readable bookmarks.
  const siblings = children(doc, root.dict);
  const [last, lastDict] = siblings.at(-1) || [];
  if (lastDict instanceof PDFDict) {
    lastDict.set(name('Next'), itemRef);
    item.set(name('Prev'), last);
  } else root.dict.set(name('First'), itemRef);
  root.dict.set(name('Last'), itemRef);
  recount(doc, root.dict, true);
  return [siblings.length];
}

export function renameBookmark(doc, path, title) {
  const text = checkTitle(title);
  const found = locate(doc, path);
  if (!found) throw new Error('This bookmark no longer exists.');
  found.dict.set(name('Title'), PDFHexString.fromText(text));
}

/** Remove a bookmark with its children; the last one removed takes the outline with it. */
export function removeBookmark(doc, path) {
  const found = locate(doc, path);
  if (!found) throw new Error('This bookmark no longer exists.');
  const { parentDict, previous, following } = found;
  // Use the same readable sibling chain as the outline UI. Imported Prev pointers can
  // be absent, stale, or point outside this parent; none may remove a different bookmark.
  const [prev, prevDict] = previous || [];
  const [next, nextDict] = following || [];
  if (prevDict instanceof PDFDict) {
    if (next) prevDict.set(name('Next'), next);
    else prevDict.delete(name('Next'));
  } else if (next) parentDict.set(name('First'), next);
  else parentDict.delete(name('First'));
  if (nextDict instanceof PDFDict) {
    if (prev) nextDict.set(name('Prev'), prev);
    else nextDict.delete(name('Prev'));
  } else if (prev) parentDict.set(name('Last'), prev);
  else parentDict.delete(name('Last'));
  const root = outlines(doc);
  if (!children(doc, root.dict).length) doc.catalog.delete(name('Outlines'));
  else recount(doc, root.dict, true);
}
