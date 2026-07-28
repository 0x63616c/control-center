// Announces the extension to the manage page.
//
// manage decides between "render an iframe" and "render a launcher card" from
// this one flag. Deliberately NOT a timeout heuristic: a cross-origin frame that
// is refused never fires `load`, so any "did it render?" guess is a race that
// gets slower networks wrong. Presence of the extension is a fact we can read
// directly, so we read it.
document.documentElement.dataset.manageExt = chrome.runtime.getManifest().version;
