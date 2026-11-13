/** Keep the coordinator read-only and gate delegated execution on current session policy. */
export const name = 'hermes-preset-guard'
export const inject = ['tools', 'sandboxPolicy']

/** Register a scoped, monotonic policy over the deployment's coordinator tool list. */
export function apply(ctx, config) {
  if (!Array.isArray(config?.allowedTools) || config.allowedTools.some(name => typeof name !== 'string' || !name)) {
    throw new TypeError('Hermes coordinator requires an explicit allowedTools list')
  }
  const allowed = new Set(config.allowedTools)
  ctx.effect(() => ctx.tools.guard(exec => {
    if (!allowed.has(exec.name)) return 'Hermes 프리셋에서는 직접 실행 대신 Hermes에 작업을 위임하세요.'
    if (exec.name !== 'subagent_hermes' && exec.name !== 'send_message') return undefined
    if (!exec.agent) return 'Hermes 위임에는 작업 세션이 필요합니다.'
    if (ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode === 'read-only') {
      return '읽기 전용에서는 Hermes 작업을 시작할 수 없습니다. 실행 권한을 변경하거나 Qwen 직접 실행 프리셋을 선택하세요.'
    }
    const plan = ctx.get('planMode')?.get(exec.agent)
    if (plan && (plan.pending ?? plan.active)) return '계획 모드에서는 Hermes 실행을 시작할 수 없습니다.'
    return undefined
  }))
}
