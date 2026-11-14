import { describe, expect, it } from 'vitest'
import { ciTimeBudget } from './calibration.ts'

describe('CI benchmark time calibration', () => {
  it('applies the slower hosted EPYC 7763 calibration only to that runner profile', () => {
    expect(ciTimeBudget(12, 'AMD EPYC 7763 64-Core Processor')).toBe(33)
    expect(ciTimeBudget(12, 'AMD EPYC 9V74')).toBe(30)
    expect(ciTimeBudget(12, 'unknown CPU')).toBe(30)
  })
})
