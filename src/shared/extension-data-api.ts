// The methods and the events of the data APIs Lucium gives extensions (chrome.history, chrome.bookmarks, chrome.browsingData): two tables, and no
// import. The preload of the extension contexts (src/preload/extension-shims.ts) is handed them, and a preload is built whole, with everything its
// imports reach: read from extension-data.ts, they brought the two catalogues of the interface's texts (nearly a megabyte) into a script that
// every worker and page of an extension loads twice. What the main process answers to each method is in extension-data.ts.

/**
 * Every method of each API, as the extension API defines them. The preload defines exactly these for an extension with the permission, and the main
 * process answers each one: reading, or a refusal that says why (the writes), never a silent nothing.
 */
export const DATA_API_METHODS: Readonly<Record<string, readonly string[]>> = {
  history: ['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange', 'deleteAll'],
  bookmarks: ['getTree', 'getSubTree', 'get', 'getChildren', 'getRecent', 'search', 'create', 'update', 'move', 'remove', 'removeTree'],
  browsingData: ['remove', 'removeCache', 'removeCookies', 'removeLocalStorage', 'removeIndexedDB', 'removeServiceWorkers', 'removeCacheStorage', 'removeHistory', 'settings']
}

/** The events of those APIs. Nothing fires them yet: the history and the favourites are not watched on behalf of extensions. */
export const DATA_API_EVENTS: Readonly<Record<string, readonly string[]>> = {
  history: ['onVisited', 'onVisitRemoved'],
  bookmarks: ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered', 'onImportBegan', 'onImportEnded'],
  browsingData: []
}
