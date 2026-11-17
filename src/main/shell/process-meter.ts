// What Electron measures of the processes of the application, for the readers of their figures: the task manager, the card of a tab and the
// resource panel of the sidebar. The processor is in % of one core over each reader's own interval (shared/processes.ts, CpuMeter): each reader
// has its meter, so that one asking does not shorten the other's interval.

import { cpus } from 'node:os'
import { app } from 'electron'
import { CpuMeter, type RawProcess } from '@shared/processes'

/** A measure of every process, with a processor meter of its own: call it once per reader, then call what it returns at each measure. */
export function processMeter(): () => RawProcess[] {
  const meter = new CpuMeter(Math.max(1, cpus().length))
  return () => {
    const metrics = app.getAppMetrics()
    const shares = meter.measure(metrics.map((m) => ({ pid: m.pid, creationTime: m.creationTime, cumulativeSeconds: m.cpu.cumulativeCPUUsage, percentAllCores: m.cpu.percentCPUUsage })), Date.now())
    return metrics.map((m) => ({ pid: m.pid, type: m.type, cpu: shares.get(m.pid) ?? 0, memoryKb: m.memory.workingSetSize }))
  }
}
