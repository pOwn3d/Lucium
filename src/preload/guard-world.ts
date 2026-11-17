// The code that runs INSIDE a page, in its main world, before any of its scripts (handed over by page-guard.ts through
// `contextBridge.executeInMainWorld`, which serializes the function: it must stay self-contained, so no import and no module-level helper is
// used in it). Two jobs, each switched on by the plan the main process sends for this document:
//
//  - the scriptlets of the blocker: a small library of OUR code, selected by name with arguments that were checked twice (src/shared/scriptlets.ts).
//    Nothing a list contains is ever evaluated: the plan holds names and plain strings, and the strings are only compared or used as property names.
//  - the fingerprint protection: stable, per-site noise on what a script reads back from canvas, WebGL and audio, and narrower figures from
//    `navigator` and `screen` (src/shared/fingerprint.ts).
//
// The same function is also run, as text, in the frames inside a page and in its workers (src/shared/inner-guard.ts): it reads every object
// through `globalThis` and checks that each one exists, because a worker has no document, no screen and no canvas element.
//
// Everything is patched through Proxies of the real functions, so names, lengths and `toString()` stay those of the browser's own. A part that
// cannot be installed is reported on the console (with its name) and the others go on: a page is never stopped by the guard itself.

import type { FingerprintConfig } from '../shared/fingerprint'
import type { GuardPlan } from '../shared/page-guard'
import type { ScriptletCall } from '../shared/scriptlets'

export function guardWorld(plan: GuardPlan): void {
  const w = globalThis as any
  const Reflect_ = Reflect
  const apply = Reflect_.apply as (target: Function, thisArg: unknown, args: ArrayLike<unknown>) => any
  const define = Object.defineProperty
  const describe = Object.getOwnPropertyDescriptor
  const protoOf = Object.getPrototypeOf
  const Proxy_ = Proxy
  const fnToString = Function.prototype.toString
  // The functions of the language the wrappers call when a page calls them, taken now as well: the page's scripts come after this one, and a
  // global one of them replaces later (`Object.keys`, `Promise.resolve`, `String`…) would otherwise be what a scriptlet runs, and how a page
  // would watch it or make it answer wrong.
  const String_ = String
  const Number_ = Number
  const RegExp_ = RegExp
  const hasOwn = Object.hasOwn
  const keysOf = Object.keys
  const arrayFrom = Array.from as <T>(items: ArrayLike<T> | Iterable<T>) => T[]
  const isArray = Array.isArray
  const random = Math.random
  const parseInt_ = Number.parseInt
  const Promise_ = Promise
  const promiseResolve = Promise_.resolve
  const resolved = <T>(value: T): Promise<T> => apply(promiseResolve, Promise_, [value])
  /** Tells the console, which is the only place a page-side guard can speak to; a page without one has nobody left to tell. The page can read its console: the line does not name the browser. */
  const tell = (level: 'warn' | 'debug', message: string, error: unknown): void => {
    try {
      w.console[level](`[guard] ${message}:`, error instanceof Error ? error.message : String_(error))
    } catch {
      // The console itself failed: the guard goes on, as it must.
    }
  }
  const warn = (what: string, error: unknown): void => tell('warn', `${what} could not be installed`, error)

  // ---- looking native: a patched function answers toString() with the text of the function it stands for ----
  const disguised = new WeakMap<object, string>()
  const disguise = <T extends object>(fake: T, real: Function): T => {
    disguised.set(fake, apply(fnToString, real, []))
    return fake
  }
  let toStringPatched = false
  const patchToString = (): void => {
    if (toStringPatched) return
    toStringPatched = true
    const patched = new Proxy_(fnToString, {
      apply(target, thisArg, args) {
        const said = typeof thisArg === 'object' || typeof thisArg === 'function' ? disguised.get(thisArg as object) : undefined
        return said !== undefined ? said : apply(target, thisArg, args)
      }
    })
    disguised.set(patched, apply(fnToString, fnToString, []))
    define(Function.prototype, 'toString', { value: patched, writable: true, configurable: true, enumerable: false })
  }
  /** Replaces a function-valued property by a Proxy of it whose `apply` is `handler`, keeping the property's attributes. */
  const wrap = (owner: any, name: string, handler: (target: any, thisArg: any, args: any[]) => any): boolean => {
    const d = describe(owner, name)
    if (!d || typeof d.value !== 'function') return false
    const proxy = disguise(new Proxy_(d.value, { apply: handler }), d.value)
    define(owner, name, { ...d, value: proxy })
    patchToString()
    return true
  }
  /** Same for the getter of an accessor property. */
  const wrapGetter = (owner: any, name: string, handler: (value: any, thisArg: any) => any): boolean => {
    const d = describe(owner, name)
    if (!d || typeof d.get !== 'function') return false
    const proxy = disguise(new Proxy_(d.get, { apply: (target, thisArg, args) => handler(apply(target, thisArg, args), thisArg) }), d.get)
    define(owner, name, { ...d, get: proxy })
    patchToString()
    return true
  }

  // ====================================================================================================
  // Scriptlets
  // ====================================================================================================
  const runScriptlets = (calls: ScriptletCall[]): void => {
    const textOf = (fn: unknown): string => {
      try {
        return typeof fn === 'function' ? apply(fnToString, fn, []) : String_(fn)
      } catch (error) {
        // A value that cannot even be turned into text is not one a needle can be found in.
        tell('debug', 'a function could not be read as text', error)
        return ''
      }
    }
    /** `/body/i` is an expression (already checked to be cheap), anything else is a plain piece of text; empty matches everything. */
    const matcher = (needle: string | undefined): ((text: string) => boolean) => {
      if (needle === undefined || needle === '') return () => true
      const found = /^\/(.+)\/(i?)$/s.exec(needle)
      if (found) {
        try {
          const re = new RegExp_(found[1]!, found[2])
          return (text) => re.test(String_(text).slice(0, 10000))
        } catch (error) {
          warn(`the pattern ${needle.slice(0, 40)}`, error)
          return () => false
        }
      }
      return (text) => String_(text).includes(needle)
    }
    // The message of the error a script of the page is stopped with, which that script can catch and read: random letters, no name of ours.
    const token = (): string => random().toString(36).slice(2, 10) || 'x'
    const noopFunc = (): void => {}
    const constants: Record<string, () => unknown> = {
      undefined: () => undefined,
      false: () => false,
      true: () => true,
      null: () => null,
      noopFunc: () => noopFunc,
      trueFunc: () => () => true,
      falseFunc: () => () => false,
      emptyObj: () => ({}),
      emptyArr: () => [],
      yes: () => 'yes',
      no: () => 'no',
      "''": () => '',
      '': () => ''
    }
    const constantOf = (text: string): unknown => (hasOwn(constants, text) ? constants[text]!() : Number_(text))

    /** Finds the descriptor of a property, on the object or up its prototype chain. */
    const findDescriptor = (owner: any, prop: string): PropertyDescriptor | undefined => {
      for (let o = owner; o !== null && o !== undefined; o = protoOf(o)) {
        const d = describe(o, prop)
        if (d) return d
      }
      return undefined
    }
    const isObjectLike = (v: unknown): boolean => v !== null && (typeof v === 'object' || typeof v === 'function')
    /**
     * Follows `a.b.c` from the window. A step that does not exist yet is waited for: the property is replaced by one that remembers what
     * the page puts there and goes on from it. `leaf(owner, prop)` is called once the owner of the last name is known.
     */
    const follow = (owner: any, props: string[], leaf: (owner: any, prop: string) => void): void => {
      const [prop, ...rest] = props
      if (prop === undefined) return
      if (rest.length === 0) {
        leaf(owner, prop)
        return
      }
      const d = findDescriptor(owner, prop)
      let current: unknown
      try {
        current = d ? ('value' in d ? d.value : d.get ? apply(d.get, owner, []) : undefined) : undefined
      } catch (error) {
        // A getter that throws is the page's own; the step is waited for like one that does not exist yet.
        tell('debug', `the property ${prop} could not be read`, error)
        current = undefined
      }
      if (isObjectLike(current)) {
        follow(current, rest, leaf)
        return
      }
      if (d && d.configurable === false) {
        tell('warn', `the property ${prop} cannot be watched (it is not configurable)`, 'skipped')
        return
      }
      let held = current
      define(owner, prop, {
        configurable: true,
        enumerable: d ? d.enumerable : true,
        get: () => held,
        set: (value: unknown) => {
          held = value
          if (isObjectLike(value)) follow(value, rest, leaf)
        }
      })
    }
    /** Puts a getter/setter on the last property that keeps the value the page stored and lets `onGet` / `onSet` act first. */
    const trap = (owner: any, prop: string, onGet: (() => void) | null, onSet: ((value: unknown) => void) | null): void => {
      const d = findDescriptor(owner, prop)
      let held: unknown = d && 'value' in d ? d.value : undefined
      const inheritedGet = d && d.get ? d.get : null
      const inheritedSet = d && d.set ? d.set : null
      try {
        define(owner, prop, {
          configurable: true,
          enumerable: d ? d.enumerable : true,
          get() {
            onGet?.()
            return inheritedGet ? apply(inheritedGet, this, []) : held
          },
          set(value: unknown) {
            onSet?.(value)
            if (inheritedSet) apply(inheritedSet, this, [value])
            else held = value
          }
        })
      } catch (error) {
        warn(`the property ${prop}`, error)
      }
    }
    const props = (chain: string): string[] => chain.split('.')

    const timers = (name: 'setTimeout' | 'setInterval', args: string[]): void => {
      const text = matcher(args[0])
      const delay = args[1] ?? ''
      const wanted = delay.replace(/^!/, '')
      const inverted = delay.startsWith('!')
      const delayMatches = (given: unknown): boolean => wanted === '' || (parseInt_(String_(given), 10) === parseInt_(wanted, 10)) !== inverted
      wrap(w, name, (target, thisArg, rest) => {
        if (typeof rest[0] === 'function' && text(textOf(rest[0])) && delayMatches(rest[1])) rest = [noopFunc, ...rest.slice(1)]
        return apply(target, thisArg, rest)
      })
    }

    /** Paths of json-prune: `a.b`, `a.*.b`, `a.[].b`; `onFinal` gets the owner and the key of the last step of each match. */
    const eachPath = (root: any, path: string, onFinal: (owner: any, key: string) => void): void => {
      const walk = (value: any, steps: string[]): void => {
        if (!isObjectLike(value) || steps.length === 0) return
        const [step, ...rest] = steps
        if (step === '[]' || step === '*') {
          if (step === '[]' && !isArray(value)) return
          for (const key of keysOf(value)) {
            if (rest.length === 0) onFinal(value, key)
            else walk(value[key], rest)
          }
          return
        }
        if (!hasOwn(value, step!)) return
        if (rest.length === 0) onFinal(value, step!)
        else walk(value[step!], rest)
      }
      walk(root, path.split('.'))
    }
    const hasPath = (root: any, path: string): boolean => {
      let found = false
      eachPath(root, path, () => {
        found = true
      })
      return found
    }

    const attributeRemoval = (kind: 'attr' | 'class', args: string[]): void => {
      const names = args[0]!.split('|')
      const selector = args[1] && args[1] !== '' ? args[1] : kind === 'attr' ? names.map((n) => `[${n}]`).join(',') : names.map((n) => `.${n}`).join(',')
      const behaviors = (args[2] ?? 'asap').split(/\s+/)
      const stay = behaviors.includes('stay') || args[2] === undefined
      const late = behaviors.includes('complete')
      let scheduled = false
      const run = (): void => {
        scheduled = false
        let elements: ArrayLike<Element>
        try {
          elements = w.document.querySelectorAll(selector)
        } catch (error) {
          warn(`the selector ${selector.slice(0, 40)}`, error)
          return
        }
        for (const element of arrayFrom(elements)) for (const name of names) kind === 'attr' ? element.removeAttribute(name) : element.classList.remove(name)
      }
      const later = (): void => {
        if (scheduled) return
        scheduled = true
        w.setTimeout(run, 50)
      }
      const start = (): void => {
        run()
        if (stay) new w.MutationObserver(later).observe(w.document, { childList: true, subtree: true, attributes: true })
      }
      if (late && w.document.readyState !== 'complete') w.addEventListener('load', start, { once: true })
      else if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', start, { once: true })
      else start()
    }

    const library: Record<ScriptletCall['id'], (args: string[]) => void> = {
      'set-constant': ([chain, value]) => {
        const constant = constantOf(value!)
        follow(w, props(chain!), (owner, prop) => {
          const d = findDescriptor(owner, prop)
          if (d && d.configurable === false) {
            warn(`the scriptlet set-constant on ${prop}`, 'the property cannot be redefined')
            return
          }
          define(owner, prop, { configurable: true, enumerable: d ? d.enumerable : true, get: () => constant, set: () => {} })
        })
      },
      'abort-on-property-read': ([chain]) => {
        follow(w, props(chain!), (owner, prop) =>
          trap(
            owner,
            prop,
            () => {
              throw new ReferenceError(token())
            },
            null
          )
        )
      },
      'abort-on-property-write': ([chain]) => {
        follow(w, props(chain!), (owner, prop) =>
          trap(owner, prop, null, () => {
            throw new ReferenceError(token())
          })
        )
      },
      'abort-current-script': ([chain, needle]) => {
        const inScript = matcher(needle)
        follow(w, props(chain!), (owner, prop) =>
          trap(
            owner,
            prop,
            () => {
              const script = w.document.currentScript
              // A property read by the browser or by an event handler has no current script: nothing to abort.
              if (script === null || script === undefined) return
              if (inScript(`${script.src ?? ''}\n${script.textContent ?? ''}`)) throw new ReferenceError(token())
            },
            null
          )
        )
      },
      'no-setTimeout-if': (args) => timers('setTimeout', args),
      'no-setInterval-if': (args) => timers('setInterval', args),
      'no-fetch-if': ([needle]) => {
        const url = matcher(needle!.replace(/^url:/, ''))
        wrap(w, 'fetch', (target, thisArg, rest) => {
          let address = ''
          try {
            address = typeof rest[0] === 'string' ? rest[0] : isObjectLike(rest[0]) && typeof rest[0].url === 'string' ? rest[0].url : String_(rest[0])
          } catch (error) {
            // An argument that cannot be read as an address is the page's to deal with: the request is not ours to stop.
            tell('debug', 'the address of a fetch could not be read', error)
          }
          if (url(address)) return resolved(new w.Response('', { status: 200, statusText: 'OK' }))
          return apply(target, thisArg, rest)
        })
      },
      'json-prune': ([prune, required]) => {
        const toPrune = prune!.split(/\s+/).filter(Boolean)
        const needed = (required ?? '').split(/\s+/).filter(Boolean)
        const prunePaths = (value: any): any => {
          if (!isObjectLike(value)) return value
          if (needed.some((path) => !hasPath(value, path))) return value
          for (const path of toPrune) eachPath(value, path, (owner, key) => Reflect_.deleteProperty(owner, key))
          return value
        }
        wrap(w.JSON, 'parse', (target, thisArg, rest) => prunePaths(apply(target, thisArg, rest)))
        if (w.Response && w.Response.prototype) {
          wrap(w.Response.prototype, 'json', (target, thisArg, rest) => {
            const result = apply(target, thisArg, rest)
            return result && typeof result.then === 'function' ? result.then(prunePaths) : result
          })
        }
      },
      'prune-response': ([address, paths]) => {
        const url = matcher(address)
        const pruneList = paths!.split(/\s+/).filter(Boolean)
        const nativeParse = w.JSON.parse as (text: string) => unknown
        const nativeStringify = w.JSON.stringify as (value: unknown) => string
        /** Removes the paths from a parsed value in place; true when something was there to remove. */
        const pruneObject = (value: any): boolean => {
          let removed = false
          for (const path of pruneList) {
            eachPath(value, path, (owner, key) => {
              removed = true
              Reflect_.deleteProperty(owner, key)
            })
          }
          return removed
        }
        // The text last read is kept: a page reads the same answer again and again (through the getters of an XHR), and it is parsed once.
        let lastText = ''
        let lastOut = ''
        /** The text with the paths removed, or the very same text when it is not JSON or holds none of them (nothing is re-serialised). */
        const pruneText = (text: string): string => {
          if (text === lastText) return lastOut
          let out = text
          if (/^\s*[[{]/.test(text)) {
            try {
              const parsed = apply(nativeParse, w.JSON, [text])
              if (isObjectLike(parsed) && pruneObject(parsed)) out = apply(nativeStringify, w.JSON, [parsed])
            } catch (error) {
              // Not JSON after all (a page, a script): it is read as it is, and the console says so in debug only.
              tell('debug', 'a response is not JSON, read as it is', error)
            }
          }
          lastText = text
          lastOut = out
          return out
        }
        /** The absolute address of a request (`fetch` takes a string, a URL or a Request; XHR takes a string that may be relative to the page). */
        const absolute = (input: unknown): string => {
          try {
            const raw = typeof input === 'string' ? input : isObjectLike(input) && typeof (input as any).url === 'string' ? (input as any).url : String_(input)
            return new w.URL(raw, w.location.href).href
          } catch (error) {
            // An address that cannot be read is not one the rule is about: the request goes on as it is.
            tell('debug', 'the address of a request could not be read', error)
            return ''
          }
        }
        // The responses (fetch) and the requests (XHR) whose address matched: only these are changed.
        const answers = new WeakSet<object>()

        if (w.fetch) {
          wrap(w, 'fetch', (target, thisArg, rest) => {
            const result = apply(target, thisArg, rest)
            if (!url(absolute(rest[0])) || !result || typeof result.then !== 'function') return result
            return result.then((response: unknown) => {
              if (isObjectLike(response)) answers.add(response as object)
              return response
            })
          })
        }
        if (w.Response && w.Response.prototype) {
          wrap(w.Response.prototype, 'text', (target, thisArg, rest) => {
            const result = apply(target, thisArg, rest)
            if (!answers.has(thisArg) || !result || typeof result.then !== 'function') return result
            return result.then((text: unknown) => (typeof text === 'string' ? pruneText(text) : text))
          })
          wrap(w.Response.prototype, 'json', (target, thisArg, rest) => {
            const result = apply(target, thisArg, rest)
            if (!answers.has(thisArg) || !result || typeof result.then !== 'function') return result
            return result.then((value: unknown) => {
              if (isObjectLike(value)) pruneObject(value)
              return value
            })
          })
        }
        if (w.XMLHttpRequest && w.XMLHttpRequest.prototype) {
          // The address is known when the page opens the request; a reused object is judged again on each `open`.
          wrap(w.XMLHttpRequest.prototype, 'open', (target, thisArg, rest) => {
            if (isObjectLike(thisArg)) {
              if (url(absolute(rest[1]))) answers.add(thisArg)
              else answers.delete(thisArg)
            }
            return apply(target, thisArg, rest)
          })
          for (const name of ['response', 'responseText']) {
            wrapGetter(w.XMLHttpRequest.prototype, name, (value, thisArg) => {
              if (!answers.has(thisArg)) return value
              if (typeof value === 'string') return pruneText(value)
              if (isObjectLike(value)) pruneObject(value)
              return value
            })
          }
        }
      },
      'remove-attr': (args) => attributeRemoval('attr', args),
      'remove-class': (args) => attributeRemoval('class', args),
      'prevent-addEventListener': ([typeNeedle, handlerNeedle]) => {
        if ((typeNeedle ?? '') === '' && (handlerNeedle ?? '') === '') return
        const type = matcher(typeNeedle)
        const handler = matcher(handlerNeedle)
        wrap(w.EventTarget.prototype, 'addEventListener', (target, thisArg, rest) => {
          const listener = rest[1]
          const asked = isObjectLike(listener) && typeof listener !== 'function' ? textOf(listener.handleEvent) : textOf(listener)
          if (type(String_(rest[0])) && handler(asked)) return undefined
          return apply(target, thisArg, rest)
        })
      },
      'no-window-open-if': ([needle]) => {
        const inverted = (needle ?? '').startsWith('!')
        const url = matcher((needle ?? '').replace(/^!/, ''))
        wrap(w, 'open', (target, thisArg, rest) => {
          if (url(String_(rest[0] ?? '')) !== inverted) return { closed: true, close: noopFunc, focus: noopFunc, blur: noopFunc, postMessage: noopFunc }
          return apply(target, thisArg, rest)
        })
      }
    }

    for (const call of calls) {
      try {
        library[call.id](call.args)
      } catch (error) {
        warn(`the scriptlet ${call.id}`, error)
      }
    }
  }

  // ====================================================================================================
  // Fingerprint protection
  // ====================================================================================================
  const reduceFingerprint = (cfg: FingerprintConfig): void => {
    const seed = cfg.seed >>> 0
    const rng = (state: number): (() => number) => {
      let a = state | 0
      return () => {
        a = (a + 0x6d2b79f5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    /**
     * Alters a few opaque pixels of RGBA bytes by one unit in one channel. The pixels are chosen from the seed and the size only, so the same
     * picture is read the same way twice; a pixel with no alpha is never touched (a transparent canvas stays transparent).
     */
    const noiseRgba = (data: Uint8Array | Uint8ClampedArray, salt: number): void => {
      const pixels = data.length >> 2
      if (pixels === 0) return
      let visible = 0
      for (let p = 3; p < data.length; p += 4) if (data[p] !== 0) visible++
      if (visible === 0) return
      const random = rng(seed ^ salt ^ Math.imul(pixels, 2654435761))
      const wanted = Math.min(visible, Math.max(4, Math.floor(pixels / cfg.pixelsPerAlteration)))
      const ranks: number[] = []
      for (let k = 0; k < wanted; k++) ranks.push(Math.floor(random() * visible))
      ranks.sort((a, b) => a - b)
      let rank = 0
      let next = 0
      for (let p = 0; p < pixels && next < ranks.length; p++) {
        if (data[p * 4 + 3] === 0) continue
        while (next < ranks.length && ranks[next] === rank) {
          const at = p * 4 + Math.floor(random() * 3)
          const value = data[at]!
          data[at] = value === 0 ? 1 : value === 255 ? 254 : value + (random() < 0.5 ? -1 : 1)
          next++
        }
        rank++
      }
    }

    const noiseFloats = (data: any, salt: number): void => {
      const length = data.length
      if (!(length > 0) || length > cfg.audioMaxSamples) return
      const random = rng(seed ^ salt ^ Math.imul(length, 2654435761))
      for (let i = 0; i < length; i++) data[i] = data[i] * (1 + (random() - 0.5) * 2e-7)
    }

    // ---- canvas ----
    const canvasProto = w.HTMLCanvasElement && w.HTMLCanvasElement.prototype
    const context2d = w.CanvasRenderingContext2D && w.CanvasRenderingContext2D.prototype
    // The functions the copy is made with are taken now: a page that replaces `document.createElement` or a method of the context later must not
    // be able to see, or steer, the guard reading its own canvas.
    const valueOf = (owner: any, name: string): Function | undefined => {
      const found = owner ? describe(owner, name)?.value : undefined
      return typeof found === 'function' ? found : undefined
    }
    const nativeGetImageData = valueOf(context2d, 'getImageData')
    const nativePutImageData = valueOf(context2d, 'putImageData')
    const nativeDrawImage = valueOf(context2d, 'drawImage')
    const nativeGetContext = valueOf(canvasProto, 'getContext')
    const nativeCreateElement = typeof w.document?.createElement === 'function' ? (w.document.createElement as Function) : undefined
    /** A copy of the canvas with the noise in it, to read instead of the canvas; null when it must be read as it is (too large, tainted, not a 2D-readable canvas). */
    const noisyCopy = (canvas: any): any => {
      try {
        const width = canvas.width
        const height = canvas.height
        if (!(width > 0 && height > 0) || width * height > cfg.canvasMaxPixels || !nativeGetImageData || !nativePutImageData || !nativeDrawImage || !nativeGetContext) return null
        const offscreen = typeof w.OffscreenCanvas === 'function' && canvas instanceof w.OffscreenCanvas
        const copy = offscreen ? new w.OffscreenCanvas(width, height) : nativeCreateElement ? apply(nativeCreateElement, w.document, ['canvas']) : null
        if (!copy) return null
        copy.width = width
        copy.height = height
        const context = apply(offscreen ? (valueOf(w.OffscreenCanvas.prototype, 'getContext') ?? nativeGetContext) : nativeGetContext, copy, ['2d'])
        if (!context) return null
        apply(nativeDrawImage, context, [canvas, 0, 0])
        const image = apply(nativeGetImageData, context, [0, 0, width, height])
        noiseRgba(image.data, width * 31 + height)
        apply(nativePutImageData, context, [image, 0, 0])
        return copy
      } catch (error) {
        // A canvas holding another site's picture refuses to be read: the page's own call fails the way it should, on the canvas itself.
        tell('debug', 'a canvas was read as it is', error)
        return null
      }
    }
    try {
      if (canvasProto) {
        for (const name of ['toDataURL', 'toBlob']) {
          wrap(canvasProto, name, (target, thisArg, rest) => {
            const copy = noisyCopy(thisArg)
            return apply(target, copy ?? thisArg, rest)
          })
        }
      }
      if (w.OffscreenCanvas && w.OffscreenCanvas.prototype) {
        wrap(w.OffscreenCanvas.prototype, 'convertToBlob', (target, thisArg, rest) => {
          const copy = noisyCopy(thisArg)
          return apply(target, copy ?? thisArg, rest)
        })
      }
      for (const proto of [context2d, w.OffscreenCanvasRenderingContext2D && w.OffscreenCanvasRenderingContext2D.prototype]) {
        if (!proto) continue
        wrap(proto, 'getImageData', (target, thisArg, rest) => {
          const image = apply(target, thisArg, rest)
          if (image && image.data && image.width * image.height <= cfg.canvasMaxPixels) noiseRgba(image.data, image.width * 31 + image.height)
          return image
        })
      }
    } catch (error) {
      warn('the canvas protection', error)
    }

    // ---- WebGL ----
    try {
      for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
        const proto = w[name] && w[name].prototype
        if (!proto) continue
        wrap(proto, 'readPixels', (target, thisArg, rest) => {
          const result = apply(target, thisArg, rest)
          const [, , width, height, format, type, buffer] = rest
          // RGBA bytes only: other formats are not pictures a page hashes.
          if (format === 0x1908 && type === 0x1401 && buffer && buffer.buffer instanceof ArrayBuffer && width * height <= cfg.canvasMaxPixels) {
            noiseRgba(new Uint8Array(buffer.buffer, buffer.byteOffset, Math.min(buffer.byteLength, width * height * 4)), width * 17 + height)
          }
          return result
        })
        if (cfg.genericGpu) {
          wrap(proto, 'getParameter', (target, thisArg, rest) => {
            // WEBGL_debug_renderer_info: UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL.
            if (rest[0] === 0x9245) return 'Google Inc.'
            if (rest[0] === 0x9246) return 'ANGLE (Generic GPU)'
            return apply(target, thisArg, rest)
          })
        }
      }
    } catch (error) {
      warn('the WebGL protection', error)
    }

    // ---- audio ----
    try {
      const noised = new WeakSet<object>()
      if (w.AudioBuffer && w.AudioBuffer.prototype) {
        wrap(w.AudioBuffer.prototype, 'getChannelData', (target, thisArg, rest) => {
          const data = apply(target, thisArg, rest)
          if (data && !noised.has(data)) {
            noised.add(data)
            noiseFloats(data, 0x51)
          }
          return data
        })
        wrap(w.AudioBuffer.prototype, 'copyFromChannel', (target, thisArg, rest) => {
          const result = apply(target, thisArg, rest)
          if (rest[0]) noiseFloats(rest[0], 0x52 + (Number_(rest[1]) | 0))
          return result
        })
      }
      if (w.AnalyserNode && w.AnalyserNode.prototype) {
        for (const name of ['getFloatFrequencyData', 'getFloatTimeDomainData']) {
          wrap(w.AnalyserNode.prototype, name, (target, thisArg, rest) => {
            const result = apply(target, thisArg, rest)
            if (rest[0]) noiseFloats(rest[0], 0x53)
            return result
          })
        }
      }
    } catch (error) {
      warn('the audio protection', error)
    }

    // ---- navigator and screen ----
    try {
      // A worker has a `WorkerNavigator` where a window has a `Navigator`: the guard runs in both (src/shared/inner-guard.ts).
      for (const name of ['Navigator', 'WorkerNavigator']) {
        const navigatorProto = w[name] && w[name].prototype
        if (!navigatorProto) continue
        wrapGetter(navigatorProto, 'hardwareConcurrency', (value) => (typeof value === 'number' && value > cfg.maxCores ? cfg.maxCores : value))
        wrapGetter(navigatorProto, 'deviceMemory', (value) => (typeof value === 'number' && value > cfg.maxMemory ? cfg.maxMemory : value))
      }
      if (cfg.roundScreen && w.Screen && w.Screen.prototype) {
        const sizes: Array<[number, number]> = [[1280, 720], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]]
        const screenProto = w.Screen.prototype
        const realWidth = apply(describe(screenProto, 'width')!.get!, w.screen, [])
        const realHeight = apply(describe(screenProto, 'height')!.get!, w.screen, [])
        // The largest common size that fits in the real screen, so a layout made for it fits too; a screen smaller than all of them keeps its figures.
        const fits = sizes.filter(([sw, sh]) => sw <= realWidth && sh <= realHeight)
        const chosen = fits.length > 0 ? fits[fits.length - 1]! : null
        if (chosen) {
          for (const name of ['width', 'availWidth']) wrapGetter(screenProto, name, () => chosen[0])
          for (const name of ['height', 'availHeight']) wrapGetter(screenProto, name, () => chosen[1])
        }
        for (const name of ['colorDepth', 'pixelDepth']) wrapGetter(screenProto, name, () => 24)
      }
    } catch (error) {
      warn('the navigator and screen protection', error)
    }

    // ---- shared workers ----
    // Nothing of ours can run in a shared worker before its script (Electron has no preload for it, and the protocol session of a page does not
    // see it start), so it reads the canvas and the figures of the machine as they are. In the strict strength a protected document has none to
    // start: the constructor is taken away, as on the browsers that never had it, and a page falls back on what it does there. The standard
    // strength leaves it, for the sites that need one, and the setting says a shared worker is not covered.
    try {
      if (cfg.removeSharedWorker && hasOwn(w, 'SharedWorker') && !Reflect_.deleteProperty(w, 'SharedWorker')) warn('the shared worker protection', 'the constructor cannot be removed')
    } catch (error) {
      warn('the shared worker protection', error)
    }

    // ---- fonts ----
    try {
      if (cfg.hideLocalFonts && typeof w.queryLocalFonts === 'function') wrap(w, 'queryLocalFonts', () => resolved([]))
    } catch (error) {
      warn('the font list protection', error)
    }
  }

  if (plan.fingerprint) {
    try {
      reduceFingerprint(plan.fingerprint)
    } catch (error) {
      warn('the fingerprint protection', error)
    }
  }
  if (plan.scriptlets.length > 0) {
    try {
      runScriptlets(plan.scriptlets)
    } catch (error) {
      warn('the scriptlets', error)
    }
  }
}
