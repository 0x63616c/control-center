/**
 * Whether the local frame-unlock extension is installed, and which version.
 *
 * The extension's content script stamps `data-manage-ext=<version>` on <html> at
 * `document_start`, so this is a fact read synchronously at boot rather than a
 * guess. The prototype's 4-second "nothing rendered yet, assume blocked" timer
 * is explicitly NOT the shipping design: a cross-origin frame that is refused
 * never fires `load`, so a timeout can only ever be a race that mislabels a slow
 * pane as a blocked one.
 */

/** Dataset key the content script writes. Exported so tests set the same thing. */
export const EXTENSION_FLAG = "manageExt";

export function extensionVersion(doc: Document = document): string | null {
  return doc.documentElement.dataset[EXTENSION_FLAG] ?? null;
}

export function hasExtension(doc: Document = document): boolean {
  return extensionVersion(doc) !== null;
}
