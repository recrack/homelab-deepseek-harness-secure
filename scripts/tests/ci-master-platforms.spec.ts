/** Scheduling policy for pull-request and post-merge CI. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const masterPush = "github.event_name == 'push' && github.ref == 'refs/heads/master'"
const runtimeBuilder = './.github/workflows/build-exe-for-python-sdk.yml'

interface Job {
  if?: string | boolean
  name?: string
  uses?: string
  needs?: string[]
  with?: Record<string, unknown>
  steps?: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }>
  'runs-on'?: string | string[]
}

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, Job>
}

function workflow(name: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', name), 'utf8')) as Workflow
}

function commands(job: Job): string[] {
  return (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])
}

describe('CI scheduling policy', () => {
  it('runs only quick Linux checks for pull requests', () => {
    const pr = workflow('ci.yml')
    expect(Object.keys(pr.on)).toEqual(['pull_request'])
    expect(Object.keys(pr.jobs)).toEqual(['all-checks-passed'])

    const checks = pr.jobs['all-checks-passed']!
    expect(checks.name).toBe('all checks passed')
    expect(commands(checks)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run test:docs',
    ])
    expect(JSON.stringify(checks)).not.toMatch(/windows|win-x64|wine|check:ci:/i)
  })

  it('runs the exhaustive Linux suite and benchmarks after a master push', () => {
    const master = workflow('ci-master.yml')
    expect(master.on.push).toEqual({ branches: ['master'] })
    expect(Object.keys(master.on).sort()).toEqual(['push', 'workflow_dispatch'])

    const fullSuite = master.jobs['serial-linux-selfhosted']!
    expect(fullSuite.if).toBe(masterPush)
    expect(fullSuite.name).toBe('serial / linux (full suite)')
    expect(fullSuite['runs-on']).toContain("vars.DSH_CI_FAILOVER_LINUX == 'github'")
    expect(fullSuite['runs-on']).toContain('ubuntu-24.04')
    expect(fullSuite['runs-on']).toContain('vm-backup')
    expect(commands(fullSuite)).toContain('pnpm run check:ci:linux-primary')
    expect(fullSuite.steps).toContainEqual(expect.objectContaining({
      if: "vars.DSH_CI_FAILOVER_LINUX == 'github'",
      run: 'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit',
    }))

    const benchmarks = master.jobs.benchmarks!
    expect(benchmarks).toMatchObject({
      if: masterPush,
      name: 'node 24 / benchmarks',
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 20,
    })
    expect(benchmarks.needs).toBeUndefined()
    expect(commands(benchmarks)).toContain('pnpm run check:ci:bench')
    const report = benchmarks.steps?.find(step => step.uses === 'actions/upload-artifact@v7.0.1')
    expect(report).toMatchObject({ with: { name: 'benchmark-report' } })
  })

  it('runs Python SDK and Linux x64 checks after a master push', () => {
    const python = workflow('ci-python.yml')
    expect(python.on.push).toEqual({ branches: ['master'] })
    expect(Object.keys(python.on)).toEqual(['push'])
    expect(python.jobs['python-sdk']!.if).toBe(masterPush)
    expect(commands(python.jobs['python-sdk']!)).toContain(
      'uv run --python 3.10 --group test --project python/sdk pytest',
    )
    expect(python.jobs['python-runtime']).toMatchObject({
      if: masterPush,
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-x64' },
    })
    expect(python.jobs['python-checks-passed']!.needs).toEqual(['python-sdk', 'python-runtime'])

    const masterRuntime = workflow('ci-master.yml').jobs['python-runtime']!
    expect(masterRuntime).toMatchObject({
      if: masterPush,
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-arm64,node24-macos-arm64,node24-macos-x64' },
    })
  })

  it('does not schedule Windows or Wine jobs in CI', () => {
    expect(existsSync(resolve(root, '.github/workflows/ci-windows.yml'))).toBe(false)
    for (const file of ['ci.yml', 'ci-python.yml', 'ci-master.yml']) {
      const current = workflow(file)
      expect(JSON.stringify(current.jobs), file).not.toMatch(/windows-2025|win-x64|wine-windows-gates|check:windows-wine/i)
    }
  })

  it('keeps the complete Python runtime matrix in release workflows', () => {
    const release = workflow('python-release.yml')
    const calls = Object.values(release.jobs).filter(job => job.uses === runtimeBuilder)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.with).toMatchObject({
      release: true,
      targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
    })
  })
})
