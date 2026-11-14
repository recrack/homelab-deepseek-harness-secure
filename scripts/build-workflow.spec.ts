import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflowPath = resolve(import.meta.dirname, '../.github/workflows/build.yml')
const workflowText = readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(workflowText) as {
  name: string
  on: Record<string, unknown>
  permissions: unknown
  jobs: Record<'build', {
    'runs-on': string
    steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>
  }>
}
const build = workflow.jobs.build

describe('PR build workflow', () => {
  it('runs on GitHub-hosted Linux or the configured Pigma self-hosted pool', () => {
    expect(workflow.name).toBe('Build')
    expect(workflow.on).toHaveProperty('pull_request')
    expect(Object.keys(workflow.jobs)).toEqual(['build'])
    expect(build['runs-on']).toContain("vars.DSH_CI_FAILOVER_LINUX == 'selfhosted'")
    expect(build['runs-on']).toContain('self-hosted')
    expect(build['runs-on']).toContain("'ubuntu-24.04'")
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(build.steps.find(step => step.uses === 'actions/checkout@v7.0.1')?.with).toEqual({ 'persist-credentials': false })
  })

  it('keeps the immutable dependency install and complete workspace build', () => {
    expect(workflowText).toContain("DSH_TELEMETRY_DISABLED: '1'")
    expect(build.steps.map(step => step.run)).toContain('pnpm install --frozen-lockfile')
    expect(build.steps.map(step => step.run)).toContain('pnpm run build')
  })

  it('does not publish or authenticate a pull-request preview site', () => {
    expect(workflowText).not.toMatch(/cloudflare|wrangler|pages deploy|CLOUDFLARE|CF_ACCESS|snapshot-diff|build:preview/i)
  })
})
