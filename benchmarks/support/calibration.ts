/** Shared conversion from reference-machine expectations to CI time budgets. */

import { cpus } from 'node:os'
import { matchMachineProfile } from './machine-profiles.ts'

/** Base measured wall-time ratio between the x64 CI runner and the arm64 reference machine. */
export const CI_TIME_SCALE = 2
/** The hosted EPYC 7763 profile repeatedly exceeds the base scale on CPU-bound CI cases. */
const EPYC_7763_TIME_SCALE = 2.2
/** Allowed variance above the calibrated expectation. */
export const PERFORMANCE_BUDGET_HEADROOM = 1.25

/**
 * Convert a reference-machine duration into its CI wall-time budget.
 * @param expectedMs - Expected duration on the reference machine.
 * @param cpuModel - CI runner CPU model; defaults to the current host.
 * @returns Integer CI budget including machine scaling and variance headroom.
 */
export function ciTimeBudget(expectedMs: number, cpuModel = cpus()[0]?.model ?? ''): number {
  const scale = matchMachineProfile(cpuModel) === 'github-ubuntu-24.04' ? EPYC_7763_TIME_SCALE : CI_TIME_SCALE
  return Math.ceil(expectedMs * scale * PERFORMANCE_BUDGET_HEADROOM)
}
