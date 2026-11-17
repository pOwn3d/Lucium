// The platform layer: every call of the main process that exists on one operating system and not on the others, behind one interface. The
// rest of the code asks `platform` instead of reading `process.platform` and calling a macOS-only Electron method. On macOS each method
// does exactly what the code did before it was moved here; elsewhere it does the nearest thing that is safe, or nothing and says so by its result.
//
// Windows and Linux were never run (docs/plateformes.md): what is written for them is the best-informed guess, held by tests that play each
// system on any machine (`createPlatform('win32')`), not a verification. Electron objects are handed in by the caller (a window, the system
// preferences), so this file imports neither Electron nor, at start-up, anything that touches the disk.

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { parsePmsetPercent, parseSysfsCapacity } from '@shared/battery-saver'
import { effectiveAccelerator, secondAccelerator, type KeyBindings } from '@shared/keybindings'
import { linksFromArgv, PLATFORM_FACTS, platformOf, revealLabel, settingsLink, splitPathList, type PlatformFacts, type PlatformId, type SettingsPane } from '@shared/platform'
import { NO_TOUCH_ID, type TouchIdPort } from '../lock-service'
import { adaptMenuTemplate } from './menu'
import { browserDataDir, importAvailable as sourceAvailable, type PathEnv, type SourceFolder } from './paths'

export interface Point {
  x: number
  y: number
}

/** The part of a window's constructor options that decides how its title bar looks. */
export interface WindowFrame {
  titleBarStyle?: 'hidden'
  trafficLightPosition?: Point
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
}

/** Colours and height of the buttons the system draws over a window whose title bar is hidden (Windows and Linux). */
export interface ControlsOverlay {
  color: string
  symbolColor: string
  height: number
}

/** What a window must have for the calls below; `BrowserWindow` has all of them (on its own platform). */
export interface VibrancyWindow {
  setVibrancy(material: string | null): void
}
export interface TrafficLightWindow {
  setWindowButtonVisibility(visible: boolean): void
  setWindowButtonPosition(position: Point | null): void
}
export interface MenuWindow {
  removeMenu(): void
}

/** `systemPreferences`, for the two calls Touch ID needs. */
export interface TouchIdSource {
  canPromptTouchID(): boolean
  promptTouchID(reason: string): Promise<void>
}

/** The reads the battery needs, handed in so a test never runs a program or reads a file of the machine. */
export interface PlatformSeams {
  /** The text `pmset -g batt` prints; rejects when it cannot run. */
  pmset?: () => Promise<string>
  /** The names in /sys/class/power_supply. */
  powerSupplies?: () => Promise<string[]>
  /** A text file of /sys/class/power_supply. */
  readText?: (path: string) => Promise<string>
}

const POWER_SUPPLY_DIR = '/sys/class/power_supply'

const realSeams: Required<PlatformSeams> = {
  pmset: () =>
    new Promise((resolve, reject) => {
      execFile('pmset', ['-g', 'batt'], { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    }),
  powerSupplies: () => readdir(POWER_SUPPLY_DIR),
  readText: (path) => readFile(path, 'utf8')
}

export interface Platform {
  readonly id: PlatformId
  readonly facts: PlatformFacts
  /** The options of a window whose title bar the page draws: macOS keeps the system's three buttons at `trafficLight`; elsewhere the system's own title bar stays unless `overlay` is given. */
  windowFrame(trafficLight: Point, overlay?: ControlsOverlay): WindowFrame
  /** Puts the material behind the window ('none' removes it). False when the system has none (nothing was called). */
  applyVibrancy(win: VibrancyWindow, material: string): boolean
  /** Shows or hides the three buttons and puts them at `position`. False when the system has none. */
  syncTrafficLights(win: TrafficLightWindow, lights: { visible: boolean; position: Point }): boolean
  /** Shows or hides the three buttons. False when the system has none. */
  setWindowButtonVisibility(win: Pick<TrafficLightWindow, 'setWindowButtonVisibility'>, visible: boolean): boolean
  /** Takes the menu bar off a window (where each window carries one). False on macOS, where the menu is the application's. */
  removeWindowMenu(win: MenuWindow): boolean
  /** Touch ID as the lock wants it: the system's on macOS, never available elsewhere. */
  touchId(source: TouchIdSource): TouchIdPort
  /** The charge of the battery, 0 to 100, or null when this system cannot say. */
  batteryPercent(): Promise<number | null>
  /** The menu template for this system (macOS: the same object). */
  adaptMenu<T extends Parameters<typeof adaptMenuTemplate>[1]>(template: T): T
  /** The accelerator of a command on this system. */
  accelerator(commandId: string, bindings: KeyBindings | undefined): string | undefined
  /** The second press of a command on this system, when it has one in force (shared/keybindings.ts). */
  secondAccelerator(commandId: string, bindings: KeyBindings | undefined): string | undefined
  readonly revealLabel: string
  settingsLink(pane: SettingsPane): string | null
  importAvailable(sourceId: string): boolean
  browserDataDir(source: SourceFolder, env: PathEnv): string | null
  splitPathList(value: string): string[]
  /** The links in a command line, for the systems that receive them there; macOS has none (the `open-url` event brings them). */
  commandLineLinks(argv: readonly string[]): string[]
}

export function createPlatform(id: PlatformId, seams: PlatformSeams = {}): Platform {
  const facts = PLATFORM_FACTS[id]
  const { pmset, powerSupplies, readText } = { ...realSeams, ...seams }

  const batteryPercent = async (): Promise<number | null> => {
    if (facts.batteryPercent === 'pmset') {
      try {
        return parsePmsetPercent(await pmset())
      } catch (error) {
        console.warn('[battery] cannot read the charge:', error instanceof Error ? error.message : String(error))
        return null
      }
    }
    if (facts.batteryPercent === 'sysfs') {
      try {
        const names = (await powerSupplies()).filter((name) => /^BAT\d+$/.test(name)).sort()
        const texts: string[] = []
        for (const name of names) texts.push(await readText(`${POWER_SUPPLY_DIR}/${name}/capacity`))
        return parseSysfsCapacity(texts)
      } catch (error) {
        console.warn('[battery] cannot read the charge:', error instanceof Error ? error.message : String(error))
        return null
      }
    }
    return null
  }

  return {
    id,
    facts,
    windowFrame: (trafficLight, overlay) => {
      if (facts.trafficLights) return { titleBarStyle: 'hidden', trafficLightPosition: trafficLight }
      return overlay ? { titleBarStyle: 'hidden', titleBarOverlay: overlay } : {}
    },
    applyVibrancy: (win, material) => {
      if (!facts.vibrancy) return false
      win.setVibrancy(material === 'none' ? null : material)
      return true
    },
    syncTrafficLights: (win, lights) => {
      if (!facts.trafficLights) return false
      win.setWindowButtonVisibility(lights.visible)
      win.setWindowButtonPosition(lights.position)
      return true
    },
    setWindowButtonVisibility: (win, visible) => {
      if (!facts.trafficLights) return false
      win.setWindowButtonVisibility(visible)
      return true
    },
    removeWindowMenu: (win) => {
      if (facts.globalMenuBar) return false
      win.removeMenu()
      return true
    },
    touchId: (source) => (facts.touchId ? { available: () => source.canPromptTouchID(), prompt: (reason) => source.promptTouchID(reason) } : NO_TOUCH_ID),
    batteryPercent,
    adaptMenu: (template) => adaptMenuTemplate(id, template) as typeof template,
    accelerator: (commandId, bindings) => effectiveAccelerator(commandId, bindings, id),
    secondAccelerator: (commandId, bindings) => secondAccelerator(commandId, bindings, id),
    revealLabel: revealLabel(id),
    settingsLink: (pane) => settingsLink(pane, id),
    importAvailable: (sourceId) => sourceAvailable(sourceId, id),
    browserDataDir: (source, env) => browserDataDir(source, id, env),
    splitPathList: (value) => splitPathList(value, id),
    commandLineLinks: (argv) => (facts.openUrlEvent ? [] : linksFromArgv(argv))
  }
}

let current: Platform | null = null

/** The platform this process runs on, made on first use. The only place `process.platform` is read for the layer. */
export function currentPlatform(): Platform {
  current ??= createPlatform(platformOf(process.platform))
  return current
}
