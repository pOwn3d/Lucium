// The engine port: the only surface the rest of Lucium uses to drive Chromium.
// Updating Chromium means updating Electron; everything Electron-specific lives behind this interface (see electron-engine.ts) so that an API
// change there cannot leak into the app.
//
// The port is written by capability in the port-*.ts files beside this one, and the rest of Lucium imports it from here only:
//   port-engine.ts           `Engine` (the pages it makes and what they may do, the private contexts), `EphemeralEngine`, `PermissionPolicy`
//   port-page.ts             `Page` (navigation, document, scripts, developer tools, keys, life), `PageKey`, `CssSlot`
//   port-page-events.ts      `PageEvents` (what a page tells the shell), `PageUpdate`, `PageMenuOptions`
//   port-media.ts            the media of a page: sound, reading aloud, Picture in Picture, the floating video
//   port-windows.ts          the place of a page in the windows: `Bounds`, `PageView`, `ViewLoan`
//   port-extensions.ts       the runtime of the extensions: shims, events, tabs and windows, workers
//   port-extension-tools.ts  the extensions as the user manages them: install, list, update, review, the Extensions page
//   port-network.ts          the requests of the sessions: blocker, page guard, privacy, DNS, proxies, icons of sites
//   port-downloads.ts        the downloads: progress, resumption, folder, name, the question before a download
//   port-storage.ts          what the sessions keep: site data, cookies, cache, profiles and containers on disk

export * from './port-engine'
export * from './port-page'
export * from './port-page-events'
export * from './port-media'
export * from './port-windows'
export * from './port-extensions'
export * from './port-extension-tools'
export * from './port-network'
export * from './port-downloads'
export * from './port-storage'
