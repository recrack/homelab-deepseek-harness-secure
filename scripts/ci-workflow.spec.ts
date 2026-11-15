import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

function evaluateRunsOn(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string') throw new TypeError('Runner selector must be a string')
  return runInNewContext(selector.trim().slice(3, -2), context, { timeout: 1000 })
}

const root = resolve(import.meta.dirname, '..')

describe('CI workflow', () => {
  it('omits the inherited weighted-approval workflows and scoring suite', () => {
    expect(existsSync(resolve(root, '.github/workflows/weighted-approval.yml'))).toBe(false)
    expect(existsSync(resolve(root, '.github/workflows/weighted-approval-review-event.yml'))).toBe(false)
    expect(existsSync(resolve(root, '.github/review-ownership'))).toBe(false)
    expect(readFileSync(resolve(root, 'package.json'), 'utf8')).not.toContain('"test:approval-policy"')
  })

  it('runs only quick Linux checks for pull requests', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    expect(Object.keys(workflow.on as object)).toEqual(['pull_request'])
    expect(Object.keys(workflow.jobs as object)).toEqual(['all-checks-passed'])

    const job = workflowJob(workflow, 'all-checks-passed')
    expect(job.name).toBe('all checks passed')
    expect(job['runs-on']).toContain('ubuntu')
    expect(job.strategy).toBeUndefined()
    if (!Array.isArray(job.steps)) throw new TypeError('PR CI must define steps')
    expect(job.steps.filter(isRecord).flatMap(step => typeof step.run === 'string' ? [step.run] : [])).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm run typecheck',
      'pnpm run lint',
      'pnpm run test:docs',
    ])
    expect(JSON.stringify(job)).not.toMatch(/windows|win-x64|wine|check:ci:/i)
  })

  it('defers the exhaustive Linux suite and benchmarks until after merge', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    expect(Object.keys(workflow.on as object).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflow.on).toHaveProperty('push', { branches: ['master'] })

    const fullSuite = workflowJob(workflow, 'serial-linux-selfhosted')
    expect(fullSuite.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(fullSuite['runs-on']).toContain("vars.DSH_CI_FAILOVER_LINUX == 'github'")
    expect(fullSuite.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run check:ci:linux-primary' }))

    const benchmarks = workflowJob(workflow, 'benchmarks')
    expect(benchmarks).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/master'",
      name: 'node 24 / benchmarks',
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 20,
    })
    expect(benchmarks.needs).toBeUndefined()
    expect(benchmarks.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run check:ci:bench' }))
    expect(JSON.stringify(workflow.jobs)).not.toMatch(/windows-2025|win-x64|wine-windows-gates|check:windows-wine/i)
  })

  it('routes the master Linux suite to GitHub-hosted Ubuntu when failover is github', () => {
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    const fullSuite = workflowJob(workflow, 'serial-linux-selfhosted')
    const selector = fullSuite['runs-on']
    const context = {
      vars: { DSH_CI_FAILOVER_LINUX: 'github' },
      fromJSON: (value: string): unknown => {
        if (value !== '["self-hosted", "linux", "x64", "vm-backup"]') {
          throw new TypeError(`Unexpected runner labels: ${value}`)
        }
        return ['self-hosted', 'linux', 'x64', 'vm-backup']
      },
    }
    expect(evaluateRunsOn(selector, context)).toBe('ubuntu-24.04')
    expect(evaluateRunsOn(selector, { ...context, vars: { DSH_CI_FAILOVER_LINUX: 'selfhosted' } }))
      .toEqual(['self-hosted', 'linux', 'x64', 'vm-backup'])
  })

  it('runs Python SDK and runtime checks only after a master push', () => {
    const workflow = loadWorkflow('.github/workflows/ci-python.yml')
    expect(Object.keys(workflow.on as object)).toEqual(['push'])
    expect(workflow.on).toHaveProperty('push', { branches: ['master'] })
    expect(workflowJob(workflow, 'python-sdk').if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(workflowJob(workflow, 'python-runtime')).toMatchObject({
      if: "github.event_name == 'push' && github.ref == 'refs/heads/master'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: { ci: true, targets: 'node24-linux-x64' },
    })
    expect(workflowJob(workflow, 'python-checks-passed').needs).toEqual(['python-sdk', 'python-runtime'])
    expect(JSON.stringify(workflow.jobs)).not.toMatch(/windows-2025|win-x64|wine/i)
    expect(existsSync(resolve(root, '.github/workflows/ci-windows.yml'))).toBe(false)
  })

  it('retains release build commands and compiled build selection', () => {
    for (const [file, command] of [
      ['release-publish.yml', 'pnpm run build:official --serial'],
      ['release-vendor-publish.yml', 'pnpm run build:lib:host'],
    ] as const) {
      expect(workflowJob(loadWorkflow('.github/workflows/' + file), 'pack').steps)
        .toContainEqual(expect.objectContaining({ name: 'Build', run: command }))
    }
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const hostSteps = scripts.scripts['build:lib:host']!.split(' && ')
    expect(hostSteps[0]).toBe('tsx scripts/compile-referenced-projects.ts host-libraries')
    expect(hostSteps).toContain('node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -p tsconfig.host.json')
    expect(hostSteps.at(-1)).toBe('pnpm --filter @deepseek-ai/dsh-desktop run bundle')
    expect(scripts.scripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
    expect(scripts.scripts.typecheck).toBe('tsx scripts/build.ts --scope typecheck')
  })

  it('selects artifact builds only for release rehearsals', () => {
    const official = "${{ github.event_name == 'pull_request' && 'pnpm run build:artifacts --profile official' || 'pnpm run build:official' }}"
    const vendor = "${{ github.event_name == 'pull_request' && 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries' || 'pnpm run build:lib:host' }}"
    for (const [file, expected] of [
      ['release.yml', official],
      ['release-vendor.yml', vendor],
    ] as const) {
      const job = workflowJob(loadWorkflow('.github/workflows/' + file), 'pack')
      if (!Array.isArray(job.steps)) throw new TypeError(`${file} pack job must define steps`)
      const step = job.steps.filter(isRecord).find(candidate => typeof candidate.run === 'string'
        && (candidate.run.includes('build:artifacts') || candidate.run.includes('host-libraries')))
      expect(step?.run).toBe(expected)
      for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
        const expression = expected.slice('${{ '.length, -' }}'.length)
        const selected: unknown = runInNewContext(expression, { github: { event_name: event } }, { timeout: 1000 })
        expect(selected).toBe(event === 'pull_request'
          ? file === 'release-vendor.yml'
            ? 'pnpm exec tsx scripts/compile-referenced-projects.ts host-libraries'
            : 'pnpm run build:artifacts --profile official'
          : file === 'release-vendor.yml' ? 'pnpm run build:lib:host' : 'pnpm run build:official')
      }
    }
  })

  it.each(['ci.yml', 'ci-master.yml', 'ci-python.yml', 'release.yml', 'release-vendor.yml'] as const)(
    '%s cancels superseded validation runs without crossing workflow or ref boundaries', (name) => {
      expect(loadWorkflow('.github/workflows/' + name).concurrency).toEqual({
        group: '${{ github.workflow }}-${{ github.ref }}',
        'cancel-in-progress': true,
      })
    },
  )

  it('does not cancel protected publication or deployment transactions', () => {
    for (const name of ['release-publish.yml', 'release-vendor-publish.yml']) {
      expect(workflowJob(loadWorkflow('.github/workflows/' + name), 'publish').concurrency)
        .toMatchObject({ 'cancel-in-progress': false })
    }
    for (const name of ['python-release.yml', 'node-addon-system-release.yml', 'docs-pages.yml']) {
      expect(loadWorkflow('.github/workflows/' + name).concurrency).toMatchObject({ 'cancel-in-progress': false })
    }
  })
})

describe('Runtime executable builder routing', () => {
  it('keeps native release and dispatch builders hosted and limits CI failover to Linux x64', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const build = workflowJob(workflow, 'build')
    expect(readFileSync(resolve(root, '.github/workflows/build-exe-for-python-sdk.yml'), 'utf8'))
      .not.toContain('DSH_CI_FAILOVER_WINDOWS')
    for (const [target, runner, blacksmith, releaseRunner] of [
      ['node24-linux-x64', 'ubuntu-latest', 'blacksmith-2vcpu-ubuntu-2404', 'ubuntu-latest'],
      ['node24-win-x64', 'windows-2025', 'windows-2025', 'windows-2025'],
      ['node24-linux-arm64', 'ubuntu-24.04-arm', 'ubuntu-24.04-arm', 'ubuntu-24.04-arm'],
      ['node24-macos-arm64', 'macos-latest', 'macos-latest', 'macos-15-xlarge'],
      ['node24-macos-x64', 'macos-15-intel', 'macos-15-intel', 'macos-15-large'],
    ] as const) {
      for (const ci of [false, true]) {
        for (const release of [false, true]) {
          for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
            const vars = { DSH_CI_FAILOVER_LINUX: mode }
            expect(evaluateRunsOn(build['runs-on'], { inputs: { ci, release }, vars, matrix: { target, runner } }), `${target} ci=${ci} release=${release} mode=${mode}`)
              .toBe(release ? releaseRunner : ci && target === 'node24-linux-x64' && mode === 'blacksmith' ? blacksmith : runner)
          }
        }
      }
    }
  })

  it.each(['plan', 'sdk-wheel'])('routes runtime %s only for non-release CI', (name) => {
    const job = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), name)
    for (const ci of [false, true]) {
      for (const release of [false, true]) {
        for (const mode of ['', 'selfhosted', 'unexpected', 'blacksmith']) {
          expect(evaluateRunsOn(job['runs-on'], { inputs: { ci, release }, vars: { DSH_CI_FAILOVER_LINUX: mode } }))
            .toBe(ci && !release && mode === 'blacksmith' ? 'blacksmith-4vcpu-ubuntu-2404' : 'ubuntu-latest')
        }
      }
    }
  })
})

describe('bubblewrap preparation script', () => {
  it('pins bubblewrap to a recorded Launchpad build and excludes Ubuntu pool downloads', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    const url = /^readonly BUBBLEWRAP_URL="([^"]+)"$/mu.exec(script)?.[1]

    expect(url).toMatch(
      /^https:\/\/launchpad\.net\/ubuntu\/\+source\/bubblewrap\/[^/]+\/\+build\/\d+\/\+files\/bubblewrap_[^/]+_amd64\.deb$/u,
    )
    // Ubuntu removes superseded versions from its live package pool.
    expect(script).not.toMatch(/https?:\/\/[^/'"\s]+\/ubuntu(?:-ports)?\/pool\//u)
  })

  it('verifies the archive against the pinned digest', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')

    expect(script).toMatch(/^readonly BUBBLEWRAP_SHA256='[0-9a-f]{64}'$/mu)
    expect(script).toContain('acquire_verified_archive "$BUBBLEWRAP_URL" "$BUBBLEWRAP_SHA256" "$archive"')
  })

  it('prepares bubblewrap on the full Linux suite and consolidated benchmark', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    expect(script).toContain('readonly BUBBLEWRAP_CACHE_DIR="${HOME}/.cache/dsh-ci/bubblewrap"')
    const workflow = loadWorkflow('.github/workflows/ci-master.yml')
    for (const name of ['serial-linux-selfhosted', 'consolidated-runner-benchmark']) {
      const job = workflowJob(workflow, name)
      if (!Array.isArray(job.steps)) throw new TypeError(`${name} must define steps`)
      expect(job.steps.some(step => isRecord(step)
        && typeof step.run === 'string'
        && step.run.includes('bash scripts/prepare-ci-bubblewrap.sh'))).toBe(true)
      expect(job.steps.filter(step => isRecord(step)
        && typeof step.uses === 'string'
        && step.uses.startsWith('actions/cache/'))).toEqual([])
    }
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    if (!isRecord(workflow.on)) throw new TypeError('python-release workflow must define on')
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(build).toMatchObject({
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

  it('exposes the keyless native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    expect(Object.keys(workflow.on as Record<string, unknown>).sort()).toEqual(['workflow_call', 'workflow_dispatch'])
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS payload architecture and deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    const cleanVenvPosix = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (POSIX)')
    const cleanVenvWindows = buildSteps.find(step => isRecord(step) && step.name === 'Install local SDK and runtime wheels into a clean venv (Windows)')
    const installedKeylessPosix = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (POSIX)')
    const installedKeylessWindows = buildSteps.find(step => isRecord(step) && step.name === 'Run installed-wheel keyless black-box tests (Windows)')
    if (!isRecord(macosCheck) || typeof macosCheck.run !== 'string'
      || !isRecord(cleanVenvPosix) || !isRecord(cleanVenvWindows)
      || !isRecord(installedKeylessPosix) || !isRecord(installedKeylessWindows)) {
      throw new TypeError('Python wheel builder must define native POSIX and Windows installed-wheel steps')
    }
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(build.defaults).toBeUndefined()
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('macosx_14_0_x86_64')
    expect(workflowJson).toContain('node24-macos-x64')
    expect(workflowJson).toContain('macos-15-intel')
    expect(workflowJson).toContain('win_amd64')
    expect(workflowJson).toContain('node24-win-x64')
    expect(workflowJson).toContain('windows-2025')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(workflowJson).not.toContain('cygpath')
    expect(workflowJson).not.toContain('DEEPSEEK_API_KEY')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm --config.verifyDepsBeforeRun=false run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('pnpm_setup_root')
    expect(JSON.stringify(manylinuxAddon)).toContain('$pnpm_setup_root:$pnpm_setup_root:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(macosCheck.run).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck.run).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck.run).toContain('$EXE-rg')
    expect(macosCheck.run).toContain('$EXE-spawn-helper')
    expect(JSON.stringify(installedKeylessPosix)).toContain('--scenario all')
    expect(JSON.stringify(installedKeylessPosix)).toContain('env -u PYTHONPATH')
    expect(JSON.stringify(installedKeylessWindows)).toContain('--scenario all --installed-wheel')
    expect(installedKeylessWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(cleanVenvWindows).toMatchObject({ if: "runner.os == 'Windows'", shell: 'pwsh' })
    expect(JSON.stringify(cleanVenvWindows)).toContain('Scripts\\\\python.exe')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it.each([
    ['POSIX', 'posix', "runner.os != 'Windows'"],
    ['Windows', 'windows', "runner.os == 'Windows'"],
  ])('runs native command regressions through the installed %s wheels', (platform, suffix, condition) => {
    const build = workflowJob(loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml'), 'build')
    if (!Array.isArray(build.steps)) throw new TypeError('Python wheel builder must define steps')
    const steps = build.steps.filter(isRecord)
    const installIndex = steps.findIndex(step => step.id === `smoke-venv-${suffix}`)
    const testIndex = steps.findIndex(step => step.name === `Run installed-wheel native command tests (${platform})`)
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(testIndex).toBeGreaterThan(installIndex)
    const install = steps[installIndex]
    const test = steps[testIndex]
    expect(install?.run).toContain('pytest>=8.0')
    expect(test).toMatchObject({ if: condition })
    expect(test).not.toHaveProperty('continue-on-error')
    expect(test?.run).toContain(`"\${{ steps.smoke-venv-${suffix}.outputs.python }}" -I`)
    expect(test?.run).toContain('run_installed_commands.py')
    if (platform === 'Windows') {
      expect(test).toHaveProperty('shell', 'pwsh')
      expect(test?.run).toContain('if ($LASTEXITCODE -ne 0) { throw')
    }
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('${PLATFORM#macos-}'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck).toContain('"$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('builds the macOS x64 wheel on the matching GitLab runner', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const macosX64 = workflow['runtime-macos-x64']
    const publish = workflow['publish-python']
    if (!isRecord(macosX64) || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the macOS x64 runtime and publication jobs')
    }

    expect(macosX64.tags).toEqual(['macos-x64'])
    expect(macosX64.variables).toMatchObject({ PKG_TARGET: 'node24-macos-x64', PLATFORM: 'macos-x64' })
    expect(publish.needs).toContainEqual({ job: 'runtime-macos-x64', artifacts: true })
    expect(JSON.stringify(publish.script)).toContain('macosx_14_0_x86_64.whl')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(JSON.stringify(windows.before_script)).toContain('.ci-python\\\\Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Issue lifecycle workflow', () => {
  it('allocates lifecycle runners only for events that can change the board', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    if (!Array.isArray(lifecycleJob.steps)) throw new TypeError('Issue lifecycle job must define steps')

    expect(lifecycle.on).toHaveProperty('pull_request')
    expect(lifecycle.on).toHaveProperty('pull_request_review')
    expect(lifecycleJob.if).toContain("github.event.review.state == 'changes_requested'")
    expect(lifecycleJob.if).toContain('github.event.changes.body != null')
    // Keep the subscription-type gates: issue-lifecycle does not re-subscribe
    // ready_for_review (issue-policy owns that) and only reacts to submitted
    // review events.
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    expect(lifecyclePullRequest.types).toContain('opened')
    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecyclePullRequest.types).not.toContain('synchronize')
    expect(lifecyclePullRequest.types).not.toContain('labeled')
    expect(lifecyclePullRequest.types).not.toContain('unlabeled')
    const issueEvents = workflowEvent(lifecycle, 'issues')
    expect(issueEvents.types).not.toContain('assigned')
    expect(issueEvents.types).not.toContain('unassigned')
    expect(issueEvents.types).toContain('typed')
    expect(issueEvents.types).toContain('untyped')
    const steps = lifecycleJob.steps.filter(isRecord)
    const tokenStep = steps.find(s => s.name === 'Create project token')
    const handleStep = steps.find(s => s.name === 'Handle repository event')
    expect(tokenStep?.if).toBeUndefined()
    expect(handleStep?.if).toBeUndefined()

    // issue-policy owns PR validation; it is read-only and a real gate.
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    expect(policyPullRequest.types).toContain('ready_for_review')
  })

  it('mints Project credentials only after preflight and always revalidates current metadata', () => {
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyJob = workflowJob(policy, 'policy')
    if (!Array.isArray(policyJob.steps)) throw new TypeError('Issue policy job must define steps')
    const steps = policyJob.steps.filter(isRecord)
    const tokenStep = steps.find(step => step.name === 'Create Project read token')
    const validateStep = steps.find(step => step.name === 'Validate pull request')
    const preflightStep = steps.find(step => step.id === 'preflight')
    expect(preflightStep).toMatchObject({ shell: 'bash' })
    expect(preflightStep?.run).toContain('if [ -f .github/issue-management/selective-preflight.json ]; then')
    expect(preflightStep?.run).toContain('node .github/issue-management/policy.mjs pr-preflight')
    expect(preflightStep?.if).toBeUndefined()
    expect(policyJob.if).toBe("github.repository == 'deepseek-harness/deepseek-harness'")
    expect(validateStep?.if).toBe("${{ steps.preflight.outputs.legacy-automated != 'true' }}")

    expect(tokenStep).toMatchObject({
      id: 'app-token',
      if: "${{ steps.preflight.outputs.needs-project == 'true' }}",
      uses: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
      with: {
        'client-id': '${{ vars.DSH_ISSUE_APP_CLIENT_ID }}',
        'private-key': '${{ secrets.DSH_ISSUE_APP_PRIVATE_KEY }}',
        owner: 'deepseek-harness',
        repositories: 'deepseek-harness',
        'permission-issues': 'read',
        'permission-organization-projects': 'read',
      },
    })
    expect(validateStep).toMatchObject({
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
        PROJECT_TOKEN: '${{ steps.app-token.outputs.token }}',
      },
    })
  })
})

describe('npm release workflows', () => {
  it('passes the optional vendor channel as a quoted argument while preserving default publication', () => {
    const workflow = loadWorkflow('.github/workflows/release-vendor-publish.yml')
    expect(workflow.on).toMatchObject({
      workflow_dispatch: {
        inputs: {
          'dist-tag': {
            required: false,
            type: 'string',
            default: '',
          },
        },
      },
    })
    const publish = workflowJob(workflow, 'publish')
    expect(publish.steps).toContainEqual({
      name: 'Publish tarballs',
      env: {
        NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}',
        RELEASE_DIST_TAG: '${{ inputs.dist-tag }}',
      },
      run: [
        'args=()',
        'if [[ -n "$RELEASE_DIST_TAG" ]]; then',
        '  args+=(--dist-tag "$RELEASE_DIST_TAG")',
        'fi',
        'pnpm run release:publish --family vendor --from dist/npm-vendor "${args[@]}"',
        '',
      ].join('\n'),
    })
  })

  it('keeps publication dispatch-only and pack in the PR workflow', () => {
    // pack stays in the PR/master release workflows so a PR proves the set packs.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(file === 'release.yml' ? ['dependencies', 'pack'] : ['pack'])
    }

    // publication is workflow_dispatch-only (never a PR check) and keeps the
    // npm-publish environment plus the shared dist-tag group.
    for (const file of ['release-publish.yml', 'release-vendor-publish.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define on and jobs`)
      expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
      const publish = workflow.jobs.publish
      if (!isRecord(publish)) throw new TypeError(`${file} must define a publish job`)
      expect(publish.environment).toBe('npm-publish')
      expect(publish.concurrency).toMatchObject({ group: 'Release-publish' })
    }
  })

  it('runs dependency policy and npm layout checks in the DSH release workflow', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const dependencies = workflowJob(workflow, 'dependencies')
    if (!isRecord(workflow.on) || !Array.isArray(dependencies.steps)) {
      throw new TypeError('DSH release workflow must define triggers and dependency steps')
    }
    const commands = dependencies.steps.flatMap(step =>
      isRecord(step) && typeof step.run === 'string' ? [step.run] : [])

    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    // Both verifications run from one step so the lane pays their longer half.
    const combined = commands.find(command => command.includes('verify-package-dependencies'))
    expect(combined).toContain('verify-npm-install-layout')
    expect(combined).toContain('wait "$dependencies_pid"')
    expect(commands).not.toContain('pnpm run verify-package-dependencies')
    expect(commands).not.toContain('pnpm run verify-npm-install-layout')
    expect(String(dependencies['runs-on'])).toContain('blacksmith-4vcpu-ubuntu-2404')
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

describe('Git hooks', () => {
  it('verifies archived notes without translation-pairing hooks', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const archive: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'archived agent notes',
      )
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(archive).toMatchObject({ run: 'node_modules/.bin/tsx scripts/verify-archived-agent-notes.ts' })
      expect(pairing).toBeUndefined()
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('Policy workflow shells', () => {
  it.each(['pr-check-on-head-branch.yml', 'pr-check-after-approve.yml', 'pr-check-on-base-branch.yml'])(
    '%s runs shell blocks that parse',
    (file) => {
      if (process.platform === 'win32') return
      const workflow = loadWorkflow('.github/workflows/' + file)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const job of Object.values(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.run !== 'string') continue
          const parsed = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' })
          expect(`${String(step.name ?? step.id)}: ${parsed.status}: ${parsed.stderr}`).toBe(`${String(step.name ?? step.id)}: 0: `)
        }
      }
    },
  )
})

describe('Policy workflows', () => {
  const workflows = [
    ['pr-check-on-head-branch.yml', ['master']],
    ['pr-check-after-approve.yml', ['approve']],
  ] as const

  function stepsOf(job: Record<string, unknown>): Record<string, unknown>[] {
    const steps = job.steps as unknown[]
    if (!Array.isArray(steps)) throw new TypeError('job must define steps')
    return steps.filter(isRecord)
  }

  it.each(workflows)('%s runs each check from master and reads its mode from a repository variable', (file, jobs) => {
    const workflow = loadWorkflow('.github/workflows/' + file)
    expect(Object.keys(workflow).filter(key => key !== 'name')).toEqual(['on', 'permissions', 'concurrency', 'jobs'])
    const events = workflow.on
    if (!isRecord(events)) throw new TypeError(`${file} must declare events`)
    expect(events).not.toHaveProperty('pull_request')
    expect(events).toHaveProperty('pull_request_target')
    for (const job of jobs) {
      const check = stepsOf(workflowJob(workflow, job)).find(step => typeof step.uses === 'string' && step.uses.startsWith('deepseek-harness/deepseek-harness-check@'))
      if (check === undefined || !isRecord(check.env)) throw new TypeError(`${file} ${job} must run the check action with env`)
      expect(String(check.env.CHECK_MODE)).toContain('vars.MERGE_POLICY_')
    }
  })

  it('runs on the release branches as well as master, on both pull requests and base-branch pushes', () => {
    const branches = ['master', 'release/dsh-[0-9]+.[0-9]+.[0-9]+']
    for (const file of ['pr-check-on-head-branch.yml', 'pr-check-after-approve.yml']) {
      const workflow = loadWorkflow('.github/workflows/' + file)
      const events = workflow.on
      if (!isRecord(events) || !isRecord(events.pull_request_target)) throw new TypeError(`${file} must trigger on pull_request_target`)
      expect(events.pull_request_target.branches).toEqual(branches)
    }
    const workflow = loadWorkflow('.github/workflows/pr-check-on-base-branch.yml')
    const events = workflow.on
    if (!isRecord(events) || !isRecord(events.push)) throw new TypeError('the base-branch workflow must trigger on push')
    expect(events.push.branches).toEqual(branches)
  })

  it('decides the review verdict in one Approve Check job that can publish the check run', () => {
    const workflow = loadWorkflow('.github/workflows/pr-check-after-approve.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('the workflow must define jobs')
    expect(Object.keys(workflow.jobs)).toEqual(['approve'])
    const job = workflow.jobs.approve
    if (!isRecord(job) || !isRecord(job.permissions)) throw new TypeError('the approve job must declare permissions')
    expect(job.name).toBe('Approve Check')
    expect(job.permissions.checks).toBe('write')
    const check = stepsOf(job).find(step => typeof step.uses === 'string' && step.uses.startsWith('deepseek-harness/deepseek-harness-check@'))
    if (check === undefined || !isRecord(check.env)) throw new TypeError('the job must run the check action with env')
    expect(String(check.env.CHECK_MODE)).toContain('vars.MERGE_POLICY_HEAD_DIFF')
    expect(JSON.stringify(workflow)).not.toContain('MERGE_POLICY_REVIEW')
  })

  it('keeps the pre-merge build behind the merge step, which honours the mode on its failures', () => {
    const steps = stepsOf(workflowJob(loadWorkflow('.github/workflows/pr-check-on-head-branch.yml'), 'pre-merge'))
    const merge = steps.findIndex(step => step.id === 'merge')
    const build = steps.findIndex(step => step.name === "Run the tree's pre-merge check")
    expect(merge).toBeGreaterThanOrEqual(0)
    expect(build).toBeGreaterThan(merge)
    const merging = steps[merge]
    if (merging === undefined || !isRecord(merging.env)) throw new TypeError('the merge step must set env')
    expect(String(merging.env.CHECK_MODE)).toContain('MERGE_POLICY_PRE_MERGE')
    for (const step of steps.slice(merge)) {
      if (typeof step.run !== 'string') continue
      expect(step.run).toContain('"$CHECK_MODE" = block')
    }
    for (const step of steps.slice(merge + 1)) expect(step.if).toBe("steps.merge.outputs.merged == 'true'")
    const run = steps[build]?.run
    if (typeof run !== 'string') throw new TypeError('the pre-merge check step must run a command')
    expect(run).toContain('node scripts/pre-merge-check.ts')
    // The script annotates its own failures; the step keeps a mode-aware guard for a check that crashes.
    expect(run).toContain('exited without reporting')
    expect(run).toContain('"$CHECK_MODE" = block')
  })
})
