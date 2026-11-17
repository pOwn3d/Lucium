// The native calls of the passage mode (docs/design/annotation-partage-fenetre.md, « Mode passage »), through koffi (FFI, prebuilt binary for darwin-arm64 in
// the optional package @koromix/koffi-darwin-arm64). Four calls and nothing else:
//  - the Accessibility permission: AXIsProcessTrustedWithOptions (ApplicationServices);
//  - the frame and the owner of a window, and whether it is on the screen: CGWindowListCopyWindowInfo (CoreGraphics), by the CGWindowID of the
//    desktopCapturer source;
//  - the activation of an application: -[NSRunningApplication activateWithOptions:] (through the Objective-C runtime);
//  - a click: CGEventCreateMouseEvent and CGEventPost (CoreGraphics), at the point given, in the screen coordinates CoreGraphics uses.
// Loaded at the first use, on macOS only: while the prototype is off, nothing of this is loaded (main/index.ts). The first use is the start of a
// share (the on-screen check) or the passage mode, whichever comes first.

import type { Box, Point } from '@shared/window-share-pass'

export interface NativeWindow {
  /** The frame of the window, in the points of the screen (origin at the top left of the main display). */
  bounds: Box
  /** The process that owns the window: the application to bring to the front. */
  pid: number
}

export interface NativeAccess {
  /** Whether Lucium may send events. With `prompt`, macOS asks for the permission when it is not granted yet (the dialog of the system). */
  trusted(prompt: boolean): boolean
  /** The window with that number (a CGWindowID), or null when no such window exists now. */
  window(windowId: number): NativeWindow | null
  /**
   * Whether that window is on the screen now: not minimized, not hidden, and on the desktop in front. Null when the system does not answer.
   * A window that is listed for the capture but not here sends no picture (see ShareState.hidden).
   */
  onScreen(windowId: number): boolean | null
  /** Brings the windows of the application of that process to the front. */
  activate(pid: number): boolean
  /** A left click at the point, sent to the window under it. */
  click(point: Point): boolean
}

// The constants of the SDK (CGEventTypes.h, CGWindow.h, CFNumber.h, CFString.h, NSRunningApplication.h); checked against the macOS 27 SDK.
const CG_HID_EVENT_TAP = 0
const CG_EVENT_LEFT_MOUSE_DOWN = 1
const CG_EVENT_LEFT_MOUSE_UP = 2
const CG_MOUSE_BUTTON_LEFT = 0
const CG_MOUSE_EVENT_CLICK_STATE = 1
const CG_WINDOW_LIST_OPTION_ALL = 0
/** Only the windows on the screen now (kCGWindowListOptionOnScreenOnly): a minimized window, a hidden one, or one on another desktop is left out. */
const CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY = 1 << 0
const CG_NULL_WINDOW_ID = 0
const CF_NUMBER_FLOAT64 = 6
const CF_STRING_ENCODING_UTF8 = 0x08000100
/**
 * NSApplicationActivateAllWindows. The other flag (IgnoringOtherApps) has no effect since macOS 14: the windows of the application come to the
 * front with this one.
 */
const NS_APPLICATION_ACTIVATE_ALL_WINDOWS = 1 << 0

/** Loads the frameworks and declares the functions. Throws off macOS, or when a framework cannot be loaded. */
export async function loadNativeAccess(): Promise<NativeAccess> {
  if (process.platform !== 'darwin') throw new Error('the passage mode needs macOS')
  const module = await import('koffi')
  const koffi: typeof import('koffi') = 'load' in module ? module : (module as unknown as { default: typeof import('koffi') }).default

  // CGPoint, by value (a struct of two doubles, as CoreGraphics declares it).
  koffi.struct('CGPoint', { x: 'double', y: 'double' })
  const coreFoundation = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const coreGraphics = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const appServices = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
  // The Objective-C runtime lives in the shared cache of the system: it is loaded by its install name.
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')

  const AXIsProcessTrustedWithOptions = appServices.func('bool AXIsProcessTrustedWithOptions(void *options)')
  const CFDictionaryCreateMutable = coreFoundation.func('void *CFDictionaryCreateMutable(void *allocator, int64 capacity, void *keyCallBacks, void *valueCallBacks)')
  const CFDictionarySetValue = coreFoundation.func('void CFDictionarySetValue(void *dict, void *key, void *value)')
  const CFDictionaryGetValue = coreFoundation.func('void *CFDictionaryGetValue(void *dict, void *key)')
  const CFStringCreateWithCString = coreFoundation.func('void *CFStringCreateWithCString(void *allocator, str cString, uint32 encoding)')
  const CFArrayGetCount = coreFoundation.func('int64 CFArrayGetCount(void *array)')
  const CFArrayGetValueAtIndex = coreFoundation.func('void *CFArrayGetValueAtIndex(void *array, int64 index)')
  const CFNumberGetValue = coreFoundation.func('bool CFNumberGetValue(void *number, int32 type, _Out_ double *value)')
  const CFRelease = coreFoundation.func('void CFRelease(void *cf)')
  const kCFBooleanTrue = koffi.decode(coreFoundation.symbol('kCFBooleanTrue'), 'void *')
  // The callbacks of a dictionary of CF objects (their addresses: the structures themselves are read by CFDictionaryCreateMutable). With them, the
  // dictionary compares its keys with CFEqual; with NULL ones it compares pointers, and macOS, which looks the option up with its own constant,
  // never found a key made here (checked with these calls on macOS 27).
  const kCFTypeDictionaryKeyCallBacks = coreFoundation.symbol('kCFTypeDictionaryKeyCallBacks')
  const kCFTypeDictionaryValueCallBacks = coreFoundation.symbol('kCFTypeDictionaryValueCallBacks')
  // The key of the option that asks for the permission: the system's own constant, not a string of the same text.
  const kAXTrustedCheckOptionPrompt = koffi.decode(appServices.symbol('kAXTrustedCheckOptionPrompt'), 'void *')

  const CGWindowListCopyWindowInfo = coreGraphics.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 relativeToWindow)')
  const CGEventCreateMouseEvent = coreGraphics.func('void *CGEventCreateMouseEvent(void *source, uint32 type, CGPoint point, uint32 button)')
  const CGEventSetIntegerValueField = coreGraphics.func('void CGEventSetIntegerValueField(void *event, uint32 field, int64 value)')
  const CGEventPost = coreGraphics.func('void CGEventPost(uint32 tap, void *event)')

  const objcGetClass = objc.func('void *objc_getClass(str name)')
  const selectorNamed = objc.func('void *sel_registerName(str name)')
  // objc_msgSend is one C function; each signature below is a declaration of it, for the arguments of one kind of method.
  const sendToObject = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int32'])
  const sendToBool = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'uint64'])

  const cfString = (text: string): unknown => {
    const made = CFStringCreateWithCString(null, text, CF_STRING_ENCODING_UTF8)
    if (!made) throw new Error(`the string ${text} could not be made`)
    return made
  }
  // The keys of the dictionaries of CoreGraphics and of the options of Accessibility: made once, kept for the life of the application.
  const keys = {
    number: cfString('kCGWindowNumber'),
    pid: cfString('kCGWindowOwnerPID'),
    bounds: cfString('kCGWindowBounds'),
    x: cfString('X'),
    y: cfString('Y'),
    width: cfString('Width'),
    height: cfString('Height')
  }

  /** A number of a CF dictionary, or null when the key is missing. */
  const numberOf = (dict: unknown, key: unknown): number | null => {
    const value = CFDictionaryGetValue(dict, key)
    if (!value) return null
    const out: [number] = [0]
    return CFNumberGetValue(value, CF_NUMBER_FLOAT64, out) ? out[0] : null
  }

  const frameOf = (dict: unknown): Box | null => {
    const rect = CFDictionaryGetValue(dict, keys.bounds)
    if (!rect) return null
    const x = numberOf(rect, keys.x)
    const y = numberOf(rect, keys.y)
    const width = numberOf(rect, keys.width)
    const height = numberOf(rect, keys.height)
    return x === null || y === null || width === null || height === null ? null : { x, y, width, height }
  }

  return {
    trusted(prompt) {
      if (!prompt) return AXIsProcessTrustedWithOptions(null)
      // A dictionary with one entry, the prompt, set to true, under the system's key; the CF callbacks retain both and compare keys by value.
      const options = CFDictionaryCreateMutable(null, 1, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks)
      if (!options) {
        console.warn('[window-share] the options of the Accessibility check could not be made: checked without asking')
        return AXIsProcessTrustedWithOptions(null)
      }
      try {
        CFDictionarySetValue(options, kAXTrustedCheckOptionPrompt, kCFBooleanTrue)
        return AXIsProcessTrustedWithOptions(options)
      } finally {
        CFRelease(options)
      }
    },

    onScreen(windowId) {
      const list = CGWindowListCopyWindowInfo(CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY, CG_NULL_WINDOW_ID)
      if (!list) return null
      try {
        const count = Number(CFArrayGetCount(list))
        for (let index = 0; index < count; index += 1) {
          const dict = CFArrayGetValueAtIndex(list, index)
          if (dict && numberOf(dict, keys.number) === windowId) return true
        }
        return false
      } finally {
        CFRelease(list)
      }
    },

    window(windowId) {
      const list = CGWindowListCopyWindowInfo(CG_WINDOW_LIST_OPTION_ALL, CG_NULL_WINDOW_ID)
      if (!list) return null
      try {
        const count = Number(CFArrayGetCount(list))
        for (let index = 0; index < count; index += 1) {
          const dict = CFArrayGetValueAtIndex(list, index)
          if (!dict || numberOf(dict, keys.number) !== windowId) continue
          const bounds = frameOf(dict)
          const pid = numberOf(dict, keys.pid)
          return bounds && pid !== null ? { bounds, pid } : null
        }
        return null
      } finally {
        CFRelease(list)
      }
    },

    activate(pid) {
      // [NSRunningApplication runningApplicationWithProcessIdentifier:pid], then [app activateWithOptions:]. A nil application (no such process) is false.
      const application = sendToObject(objcGetClass('NSRunningApplication'), selectorNamed('runningApplicationWithProcessIdentifier:'), pid)
      return application ? sendToBool(application, selectorNamed('activateWithOptions:'), NS_APPLICATION_ACTIVATE_ALL_WINDOWS) : false
    },

    click(point) {
      const at = { x: point.x, y: point.y }
      const down = CGEventCreateMouseEvent(null, CG_EVENT_LEFT_MOUSE_DOWN, at, CG_MOUSE_BUTTON_LEFT)
      const up = CGEventCreateMouseEvent(null, CG_EVENT_LEFT_MOUSE_UP, at, CG_MOUSE_BUTTON_LEFT)
      if (!down || !up) {
        for (const event of [down, up]) if (event) CFRelease(event)
        return false
      }
      // A click of one: the application counts it as a click, not as the first of a double click.
      CGEventSetIntegerValueField(down, CG_MOUSE_EVENT_CLICK_STATE, 1)
      CGEventSetIntegerValueField(up, CG_MOUSE_EVENT_CLICK_STATE, 1)
      CGEventPost(CG_HID_EVENT_TAP, down)
      CGEventPost(CG_HID_EVENT_TAP, up)
      CFRelease(down)
      CFRelease(up)
      return true
    }
  }
}
