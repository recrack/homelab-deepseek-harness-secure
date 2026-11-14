/** Verify that the committed translation prompt renders and parses as documented. */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  consumeTranslationResponse,
  documentedTranslationPromptPlaceholders,
  parseTranslationResponse,
  renderTranslationPrompt,
  renderTranslationRequest,
  renderTranslationResponse,
  TRANSLATION_PROMPT_PLACEHOLDERS,
  type TranslationExample,
} from './translation-prompt.ts'

const root = resolve(import.meta.dirname, '..')

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

try {
  const mode = process.argv[2]
  if (mode !== undefined && mode !== '--snapshot') throw new Error(`unsupported argument ${JSON.stringify(mode)}`)
  const document = read('docs/i18n/translation-prompt.md')
  const terminology = read('docs/i18n/terminology.md')
  // Synthetic reviewed examples, not live documents: editing one must not
  // churn the prompt snapshot. Keep translated samples in memory instead of
  // maintaining Chinese Markdown files in the repository.
  const examples: TranslationExample[] = [
    {
      english: read('scripts/fixtures/translation-prompt/examples/product.md'),
      chinese: '# Acme Agent\n\n[English](product.md) | 中文\n\nAcme Agent 是一款开源 agent harness，用于自动化仓库日常事务。\n\n本段包含供示例使用的中性占位文本。\n\n## 安装\n\n安装 Node.js 24，然后运行：\n\n```sh\nnpx acme-agent setup\n```\n\n该命令会打印设置地址，默认地址为 `http://127.0.0.1:3080`。\n\n## 社区\n\n- 在 Issue 跟踪器中报告 bug。\n- 为你的插件仓库添加 `acme-agent` 主题。\n',
    },
    {
      english: read('scripts/fixtures/translation-prompt/examples/rules.md'),
      chinese: '# Pairing Rules\n\n[English](rules.md) | 中文\n\n这些规则适用于用户请求的 Markdown 翻译。\n\n## 优先级\n\n| Level | Meaning |\n|---|---|\n| MUST | Follow required safety and structure rules. |\n| SHOULD | Deviate only when the reason is documented. |\n\n- 保留源文的每个命题。\n- 代码片段原样保留。\n',
    },
    {
      english: read('scripts/fixtures/translation-prompt/examples/agent-note.md'),
      chinese: '# Agent Note: Consistent Examples\n\n[English](agent-note.md) | 中文\n\n## 问题\n\n相似示例使用了不同的标题。\n\n## 决策\n\n相似示例使用相同的标题。\n\n## 后果\n\n示例更易于比较。\n',
    },
  ]
  const sourceDocument = read('scripts/fixtures/translation-prompt/snapshot-note.md')
  const recordedResponse = read('scripts/fixtures/translation-prompt/response.txt')
  const documented = documentedTranslationPromptPlaceholders(document)
  if (documented.join('\n') !== TRANSLATION_PROMPT_PLACEHOLDERS.join('\n')) {
    throw new Error(`placeholder table must list exactly: ${TRANSLATION_PROMPT_PLACEHOLDERS.join(', ')}`)
  }

  const englishInput = { sourceLanguage: 'English' as const, sourceFilename: 'snapshot-note.md', terminology }
  const englishSource = renderTranslationPrompt(document, englishInput)
  const chineseSource = renderTranslationPrompt(document, {
    sourceLanguage: 'Chinese',
    sourceFilename: 'snapshot-note.zh.md',
    terminology,
  })
  if (englishSource.includes('{{') || chineseSource.includes('{{')) throw new Error('rendered prompt contains an unresolved placeholder')
  if (!englishSource.includes('from English to Chinese')) throw new Error('English-source render does not translate into Chinese')
  if (!chineseSource.includes('from Chinese to English')) throw new Error('Chinese-source render does not translate into English')

  const example = /```xml\n([\s\S]*?)\n```/.exec(englishSource)?.[1]
  if (example === undefined) throw new Error('rendered prompt has no three-section response example')
  parseTranslationResponse(example)

  const roundTrip = { translation: 'first pass\n\nwith **markdown**', review: '- 无修正', final: 'final text' }
  const parsed = parseTranslationResponse(renderTranslationResponse(roundTrip))
  if (JSON.stringify(parsed) !== JSON.stringify(roundTrip)) throw new Error('three-section response does not round-trip')

  const request = renderTranslationRequest(document, { ...englishInput, sourceDocument, examples })
  if (request.targetFilename !== 'snapshot-note.zh.md') throw new Error('English request resolves the wrong target filename')
  const expectedRoles = ['system', ...examples.flatMap(() => ['user', 'assistant']), 'user']
  if (request.messages.map(message => message.role).join('\n') !== expectedRoles.join('\n')) {
    throw new Error('reviewed examples are not assembled as system, example pairs, then source')
  }
  const consumed = consumeTranslationResponse(recordedResponse, englishInput)
  const expectedFinalPrefix = [
    '---',
    'layout: doc',
    '---',
    '',
    '# 快照说明',
    '',
    '[English](snapshot-note.md) | 中文',
    '',
  ].join('\n')
  if (!consumed.final.startsWith(expectedFinalPrefix)) {
    throw new Error('recorded frontmatter response does not preserve metadata and receive the canonical target switcher')
  }

  if (mode === '--snapshot') {
    process.stdout.write(`${JSON.stringify({ request, response: consumed }, null, 2)}\n`)
  } else {
    console.log('verify-translation-prompt: both directions render, reviewed examples assemble, and the consumed response is target-path correct.')
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`verify-translation-prompt: ${message}`)
  process.exit(1)
}
