// Runs the commands by address (`lucium://…`, rules and threat model in shared/automation-url.ts). The system hands them over as it hands
// over any link from another application ('open-url', 'second-instance' in index.ts); they take the same road, and a command that opens a page
// goes through the same placement as such a link (the rules of Settings › Liens), so there is one way to open an address from outside.

import { AutomationLimiter, automationSearchAddress, parseAutomationUrl, type AutomationRefusal } from '@shared/automation-url'

/** What the commands need of the application; index.ts gives the real ones, a test gives its own. */
export interface AutomationHost {
  /** The setting `urlAutomation`, read at each command: a switched-off application keeps nothing of the address. */
  enabled(): boolean
  locked(): boolean
  /** A web address in a tab of the window, placed as a link from another application is (link rules, window to the front). */
  openTab(url: string): void
  /** The window to the front with the command bar open for a new tab. */
  newTab(): void
  /** The search address of the profile on screen, `%s` where the text goes. */
  searchTemplate(): string
  now(): number
}

export type AutomationOutcome = { ran: true; command: string } | { ran: false; reason: AutomationRefusal }

export class Automation {
  constructor(
    private readonly host: AutomationHost,
    private readonly limiter: AutomationLimiter = new AutomationLimiter()
  ) {}

  /** Runs what the address asks, or refuses it with a line in the log (never the parameters: a search may be private). Nothing is answered to the caller. */
  handle(raw: string): AutomationOutcome {
    const refuse = (reason: AutomationRefusal, command?: string): AutomationOutcome => {
      console.warn(`[automation] refused (${reason})${command ? ` for "${command}"` : ''}`)
      return { ran: false, reason }
    }
    const verdict = parseAutomationUrl(raw, this.host.enabled())
    if (!verdict.ok) return refuse(verdict.reason, verdict.command)
    // A locked application takes no command from outside, and keeps none for the unlocking: a tab that opens minutes later is not what was asked.
    if (this.host.locked()) return refuse('locked', verdict.command.command)
    if (!this.limiter.allow(this.host.now())) return refuse('rate', verdict.command.command)
    const { command } = verdict
    switch (command.command) {
      case 'open':
        this.host.openTab(command.url)
        break
      case 'new-tab':
        this.host.newTab()
        break
      case 'search':
        this.host.openTab(automationSearchAddress(this.host.searchTemplate(), command.query))
        break
    }
    return { ran: true, command: command.command }
  }
}

let current: Automation | null = null

/** The running one, for the engine test, which drives the same entry point as the system does. */
export const setAutomation = (automation: Automation | null): void => {
  current = automation
}
export const getAutomation = (): Automation | null => current
