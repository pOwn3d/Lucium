import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import { Channel, isPrivateSurface, type LuciumApi, type LittleState, type OverlayRequest, type UiSnapshot } from '../shared/ipc'
import type { FloatingVideoState } from '../shared/floating-video'
import type { ResourceReport } from '../shared/resources'

// The focus of the window, kept from the start: the main process tells it once the page has loaded, before the interface listens (main/shell/window-focus.ts).
let windowFocused: boolean | null = null
const windowFocusListeners = new Set<(focused: boolean) => void>()
ipcRenderer.on(Channel.windowFocus, (_e, focused: unknown) => {
  if (typeof focused !== 'boolean') return
  windowFocused = focused
  for (const listener of windowFocusListeners) listener(focused)
})

const api: LuciumApi = {
  getSnapshot: () => ipcRenderer.invoke(Channel.getSnapshot),
  dispatch: (action) => ipcRenderer.invoke(Channel.dispatch, action),
  nav: (command) => ipcRenderer.send(Channel.nav, command),
  openOverlay: (request) => ipcRenderer.send(Channel.openOverlay, request),
  closeOverlay: () => ipcRenderer.send(Channel.closeOverlay),
  submitUrl: (url, mode, instant) => ipcRenderer.send(Channel.submitUrl, url, mode, instant),
  loadExtension: () => ipcRenderer.invoke(Channel.loadExtension),
  find: (text, options) => ipcRenderer.send(Channel.find, text, options),
  searchHistory: (query, limit, profileId) => ipcRenderer.invoke(Channel.searchHistory, query, limit, profileId),
  forgetHistory: (url, profileId, undoable) => ipcRenderer.invoke(Channel.forgetHistory, url, profileId, undoable),
  putBackHistory: (url, profileId) => ipcRenderer.invoke(Channel.putBackHistory, url, profileId),
  forgetHistoryDay: (from, to, profileId) => ipcRenderer.invoke(Channel.forgetHistoryDay, from, to, profileId),
  searchPageContent: (query, profileId) => ipcRenderer.invoke(Channel.searchPageContent, query, profileId),
  clearPageIndex: () => ipcRenderer.invoke(Channel.clearPageIndex),
  showMenu: (target) => ipcRenderer.send(Channel.showMenu, target),
  showAppMenu: (anchor) => ipcRenderer.send(Channel.showAppMenu, anchor),
  toggleReadable: (id) => ipcRenderer.send(Channel.toggleReadable, id),
  downloadAction: (id, command) => ipcRenderer.send(Channel.downloadAction, id, command),
  answerPermission: (id, allow, remember) => ipcRenderer.send(Channel.answerPermission, id, allow, remember),
  answerAuth: (id, credentials) => ipcRenderer.send(Channel.answerAuth, id, credentials),
  answerExtensionReview: (id, allow) => ipcRenderer.send(Channel.answerExtensionReview, id, allow),
  openWebStore: () => ipcRenderer.send(Channel.openWebStore),
  pathOfDroppedFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch (error) {
      // Not a file of the disk (a dragged picture of a page, say): there is nothing to open, and the cause is written.
      console.warn('[drop] no path for the dropped item:', error instanceof Error ? error.message : String(error))
      return ''
    }
  },
  openLocalFiles: (paths) => ipcRenderer.send(Channel.openLocalFiles, paths),
  openDroppedLinks: (text) => ipcRenderer.send(Channel.openDroppedLinks, text),
  extensionUninstall: (profileId, extensionId) => ipcRenderer.send(Channel.extensionUninstall, profileId, extensionId),
  extensionUpdates: (target) => ipcRenderer.send(Channel.extensionUpdates, target),
  answerDialog: (id, answer) => ipcRenderer.send(Channel.answerDialog, id, answer),
  answerLeave: (id, leave) => ipcRenderer.send(Channel.answerLeave, id, leave),
  hotEdge: (inside) => ipcRenderer.send(Channel.hotEdge, inside),
  littleAction: (id, command) => ipcRenderer.send(Channel.littleAction, id, command),
  onLittleState: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, state: LittleState) => listener(state)
    ipcRenderer.on(Channel.littleState, handler)
    return () => ipcRenderer.removeListener(Channel.littleState, handler)
  },
  siteColor: () => ipcRenderer.invoke(Channel.siteColor),
  captureRegion: (rect) => ipcRenderer.send(Channel.captureRegion, rect),
  captureFullPage: () => ipcRenderer.send(Channel.captureFullPage),
  annotatePage: () => ipcRenderer.send(Channel.annotatePage),
  captureVisible: () => ipcRenderer.send(Channel.captureVisible),
  annotateImage: (id) => ipcRenderer.invoke(Channel.annotateImage, id),
  annotateDone: (request) => ipcRenderer.invoke(Channel.annotateDone, request),
  closeSidePanel: () => ipcRenderer.send(Channel.closeSidePanel),
  openSidePanel: (extensionId) => ipcRenderer.send(Channel.openSidePanel, extensionId),
  activateExtension: (extensionId) => ipcRenderer.send(Channel.activateExtension, extensionId),
  zapStart: (host, id) => ipcRenderer.send(Channel.zapStart, host, id),
  clearSiteData: () => ipcRenderer.send(Channel.clearSiteData),
  siteCookieCount: (host, subdomains) => ipcRenderer.invoke(Channel.siteCookieCount, host, subdomains),
  clearSites: (request) => ipcRenderer.invoke(Channel.clearSites, request),
  clearSiteNow: () => ipcRenderer.send(Channel.clearSiteNow),
  reloadAllTabs: (everything?: boolean) => ipcRenderer.send(Channel.reloadAllTabs, everything === true),
  reloadSpaceTabs: () => ipcRenderer.send(Channel.reloadSpaceTabs),
  splitDrag: (phase, tabId) => ipcRenderer.send(Channel.splitDrag, phase, tabId),
  splitDrop: (zone) => ipcRenderer.send(Channel.splitDrop, zone),
  cycleKey: (key) => ipcRenderer.send(Channel.cycleKey, key),
  keyboardLayout: (characters) => ipcRenderer.send(Channel.keyboardLayout, characters),
  onCycleIndex: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, index: number) => listener(index)
    ipcRenderer.on(Channel.cycleIndex, handler)
    return () => ipcRenderer.removeListener(Channel.cycleIndex, handler)
  },
  onWindowFocus: (listener) => {
    windowFocusListeners.add(listener)
    if (windowFocused !== null) listener(windowFocused)
    return () => void windowFocusListeners.delete(listener)
  },
  setWindowName: (name) => ipcRenderer.send(Channel.setWindowName, name),
  windowSidebar: (change) => ipcRenderer.send(Channel.windowSidebar, change),
  goToWindow: (id) => ipcRenderer.send(Channel.goToWindow, id),
  omniboxEnter: (request) => ipcRenderer.send(Channel.omniboxEnter, request),
  resetZoom: () => ipcRenderer.send(Channel.resetZoom),
  bookmarksTransfer: (request) => ipcRenderer.invoke(Channel.bookmarksTransfer, request),
  openAsApp: () => ipcRenderer.send(Channel.openAsApp),
  defaultBrowser: () => ipcRenderer.invoke(Channel.defaultBrowser),
  setDefaultBrowser: () => ipcRenderer.invoke(Channel.setDefaultBrowser),
  appIconIssue: () => ipcRenderer.invoke(Channel.appIconIssue),
  clearProfile: (profileId) => ipcRenderer.invoke(Channel.clearProfile, profileId),
  deleteProfile: (profileId) => ipcRenderer.invoke(Channel.deleteProfile, profileId),
  unusedProfiles: () => ipcRenderer.invoke(Channel.unusedProfiles),
  purgeProfiles: (profileIds) => ipcRenderer.invoke(Channel.purgeProfiles, profileIds),
  chooseFolder: () => ipcRenderer.invoke(Channel.chooseFolder),
  chooseOpenWith: (type) => ipcRenderer.send(Channel.chooseOpenWith, type),
  toastAction: (id, second) => ipcRenderer.send(Channel.toastAction, id, second === true),
  toastDismiss: (id) => ipcRenderer.send(Channel.toastDismiss, id),
  toastHold: (id, held) => ipcRenderer.send(Channel.toastHold, id, held),
  whatsNewDismiss: () => ipcRenderer.send(Channel.whatsNewDismiss),
  listProcesses: () => ipcRenderer.invoke(Channel.listProcesses),
  killProcess: (pid) => ipcRenderer.invoke(Channel.killProcess, pid),
  shareSite: () => ipcRenderer.send(Channel.shareSite),
  openDevTools: () => ipcRenderer.send(Channel.openDevTools),
  exportData: (request) => ipcRenderer.invoke(Channel.exportData, request),
  exportBookmarks: (options) => ipcRenderer.invoke(Channel.exportBookmarks, options),
  answerPassphrase: (id, passphrase) => ipcRenderer.send(Channel.answerPassphrase, id, passphrase),
  lockUnlock: (request) => ipcRenderer.invoke(Channel.lockUnlock, request),
  lockConfigure: (request) => ipcRenderer.invoke(Channel.lockConfigure, request),
  sync: (request) => ipcRenderer.invoke(Channel.syncRequest, request),
  passwords: (request) => ipcRenderer.invoke(Channel.passwords, request),
  moveTabsToSpace: (ids, spaceId) => ipcRenderer.send(Channel.moveTabsToSpace, ids, spaceId),
  tabDrag: (phase, ids) => ipcRenderer.send(Channel.tabDrag, phase, ids),
  dropWindowTabs: (target) => ipcRenderer.send(Channel.dropWindowTabs, target),
  tabThumbnail: (tabId) => ipcRenderer.invoke(Channel.tabThumbnail, tabId),
  tabResources: (tabId) => ipcRenderer.invoke(Channel.tabResources, tabId),
  resourcePanel: (open) => ipcRenderer.send(Channel.resourcePanel, open === true),
  onResources: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, report: ResourceReport) => listener(report)
    ipcRenderer.on(Channel.resources, handler)
    return () => ipcRenderer.removeListener(Channel.resources, handler)
  },
  resourceAction: (action) => ipcRenderer.invoke(Channel.resourceAction, action),
  suggest: (query) => ipcRenderer.invoke(Channel.suggest, query),
  media: (request) => ipcRenderer.send(Channel.media, request),
  toggleMute: (tabId) => ipcRenderer.send(Channel.tabMute, tabId),
  floatingVideoAction: (command) => ipcRenderer.send(Channel.floatingVideoAction, command),
  onFloatingVideoState: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, state: FloatingVideoState) => listener(state)
    ipcRenderer.on(Channel.floatingVideoState, handler)
    return () => ipcRenderer.removeListener(Channel.floatingVideoState, handler)
  },
  floatingVideoTab: (tabId, command) => ipcRenderer.send(Channel.floatingVideoTab, tabId, command),
  stopTabCapture: (tabId) => ipcRenderer.send(Channel.stopTabCapture, tabId),
  sleepTab: (tabId) => ipcRenderer.send(Channel.sleepTab, tabId),
  thawTab: (tabId) => ipcRenderer.send(Channel.thawTab, tabId),
  setTabAddress: (tabId, input) => ipcRenderer.send(Channel.tabAddress, tabId, input),
  blockedCount: (tabId) => ipcRenderer.invoke(Channel.blockedCount, tabId),
  blockedHosts: (tabId) => ipcRenderer.invoke(Channel.blockedHosts, tabId),
  sessionBlockedCount: () => ipcRenderer.invoke(Channel.sessionBlockedCount),
  ollamaTest: (url) => ipcRenderer.invoke(Channel.ollamaTest, url),
  ollamaModels: (url) => ipcRenderer.invoke(Channel.ollamaModels, url),
  sessionBlockedByKind: () => ipcRenderer.invoke(Channel.sessionBlockedByKind),
  resetSessionBlockedCount: () => ipcRenderer.invoke(Channel.resetSessionBlockedCount),
  updateFilterLists: () => ipcRenderer.invoke(Channel.updateFilterLists),
  addFilterListFile: () => ipcRenderer.invoke(Channel.addFilterListFile),
  addFilterListText: (title, text) => ipcRenderer.invoke(Channel.addFilterListText, title, text),
  removeFilterList: (id) => ipcRenderer.invoke(Channel.removeFilterList, id),
  tooltip: (request) => ipcRenderer.send(Channel.tooltip, request),
  copyUrl: () => ipcRenderer.send(Channel.copyUrl),
  copyCalcResult: (text) => ipcRenderer.send(Channel.copyCalcResult, text),
  readClipboardText: () => ipcRenderer.invoke(Channel.clipboardRead),
  writeClipboardText: (text) => ipcRenderer.invoke(Channel.clipboardWrite, text),
  markdownExport: (mode) => ipcRenderer.send(Channel.markdownExport, mode),
  themeCode: (request) => ipcRenderer.invoke(Channel.themeCode, request),
  boostShare: (request) => ipcRenderer.invoke(Channel.boostShare, request),
  boostPreview: (boostId) => ipcRenderer.invoke(Channel.boostPreview, boostId),
  peekAction: (action) => ipcRenderer.send(Channel.peekAction, action),
  setScrollSynced: (splitId, on) => ipcRenderer.send(Channel.setScrollSynced, splitId, on),
  importSources: () => ipcRenderer.invoke(Channel.importSources),
  importRun: (request) => ipcRenderer.invoke(Channel.importRun, request),
  importPreview: (request) => ipcRenderer.invoke(Channel.importPreview, request),
  importCommit: (token) => ipcRenderer.invoke(Channel.importCommit, token),
  importUndo: (token) => ipcRenderer.invoke(Channel.importUndo, token),
  openDiskAccessSettings: () => ipcRenderer.send(Channel.openDiskAccessSettings),
  firstLaunchPreview: (request) => ipcRenderer.invoke(Channel.firstLaunchPreview, request),
  firstLaunchConfirm: (token) => ipcRenderer.invoke(Channel.firstLaunchConfirm, token),
  findReplace: (request) => ipcRenderer.invoke(Channel.findReplace, request),
  translate: (request) => ipcRenderer.invoke(Channel.translate, request),
  aboutVersion: () => ipcRenderer.invoke(Channel.aboutVersion),
  openAbout: (target) => ipcRenderer.send(Channel.openAbout, target),
  aboutEngine: () => ipcRenderer.invoke(Channel.aboutEngine),
  aboutCheckUpdates: () => ipcRenderer.invoke(Channel.aboutCheckUpdates),
  engineStatus: () => ipcRenderer.invoke(Channel.engineStatus),
  panelScreens: () => ipcRenderer.invoke(Channel.panelScreens),
  clearErrorLog: () => ipcRenderer.invoke(Channel.clearErrorLog),
  problemReport: () => ipcRenderer.invoke(Channel.problemReport),
  saveProblemReport: () => ipcRenderer.invoke(Channel.saveProblemReport),
  openProblemSite: () => ipcRenderer.send(Channel.openProblemSite),
  sessionBackups: () => ipcRenderer.invoke(Channel.sessionBackups),
  restoreBackup: (id) => ipcRenderer.invoke(Channel.restoreBackup, id),
  backUpNow: () => ipcRenderer.invoke(Channel.backUpNow),
  asideSpace: () => ipcRenderer.send(Channel.asideSpace),
  cookieSites: () => ipcRenderer.invoke(Channel.cookieSites),
  cookieNames: (host) => ipcRenderer.invoke(Channel.cookieNames, host),
  removeCookieSite: (host) => ipcRenderer.invoke(Channel.cookieRemoveSite, host),
  cleanCookies: () => ipcRenderer.invoke(Channel.cookieClean),
  testProxy: (address) => ipcRenderer.invoke(Channel.testProxy, address),
  webHardware: (request) => ipcRenderer.invoke(Channel.webHardware, request),
  newPrivateTab: () => ipcRenderer.send(Channel.newPrivateTab),
  userScripts: (request) => ipcRenderer.invoke(Channel.userScripts, request),
  extensionsPage: (request) => ipcRenderer.invoke(Channel.extensionsPage, request),
  spaceImage: (request) => ipcRenderer.invoke(Channel.spaceImage, request),
  spaceBackgroundMedia: (request) => ipcRenderer.invoke(Channel.spaceBackgroundMedia, request),
  webPanel: (request) => ipcRenderer.send(Channel.webPanel, request),
  notes: (request) => ipcRenderer.invoke(Channel.notes, request),
  noteFiles: (request) => ipcRenderer.invoke(Channel.noteFiles, request),
  onSnapshot: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: UiSnapshot) => listener(snapshot)
    ipcRenderer.on(Channel.snapshot, handler)
    return () => ipcRenderer.removeListener(Channel.snapshot, handler)
  },
  onShowOverlay: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, request: OverlayRequest | null) => listener(request)
    ipcRenderer.on(Channel.showOverlay, handler)
    return () => ipcRenderer.removeListener(Channel.showOverlay, handler)
  }
}

contextBridge.exposeInMainWorld('lucium', api)

// Defines the <browser-action-list> element (extension icons, badges and popups) in the sidebar.
// Not in a private window: extensions do not run there, and the element would open a disk-backed session for its profile.
if (!isPrivateSurface(location.search)) injectBrowserAction()
