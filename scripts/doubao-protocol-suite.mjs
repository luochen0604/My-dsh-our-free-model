/**
 * 豆包（DoubaoWork）单元测试的运行入口（**零真实网络**）。
 *
 * ## 为什么要单独的入口，而不是塞进 channel-pack-test.mjs
 *
 * `channel-pack-test.mjs` 会挂载整个 channel pack（10 个 provider、账号池、
 * RPC、网关），那套 fixture 重且与协议无关；本套只验证：
 *
 *  - `doubao.ts` 的纯函数（帧切分、事件分类、错误分级、设备号解析）；
 *  - `doubao-adapter.ts` 的可观察行为（续会话、思考块、反问闭环、错误文案）。
 *
 * 都不需要完整宿主。
 *
 * ## 为什么需要 registerHooks
 *
 * 被测源码是 `.ts`。仓库里 `channel-pack-test.mjs --source` 已经有一套
 * 「把 `.ts` 用 typescript 即时转译成 ESM」的 hook；这里复用同款做法，
 * 使得 `node scripts/doubao-protocol-suite.mjs` **单跑**也能工作，
 * 不依赖别的测试先启动。
 *
 * 参数：`--protocol-only` 只跑纯函数测试（不加载 typescript 之外的东西），
 * 默认两个都跑。
 */
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
// 延迟加载 typescript：不跑 `.ts` 时不必付出加载成本。
let ts

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 源码里的相对导入写成 `./doubao.js`，实际文件是 `.ts`。
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      if (ts === undefined) throw new Error('doubao suite: typescript hook not initialised')
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

// hook 注册之后、任何 `.ts` 被导入之前初始化转译器。
ts = (await import('typescript')).default

const protocolOnly = process.argv.includes('--protocol-only')

const { verifyDoubaoProtocol } = await import('./doubao-protocol-test.mjs')
await verifyDoubaoProtocol()

if (!protocolOnly) {
  const { verifyDoubaoAdapter } = await import('./doubao-adapter-test.mjs')
  await verifyDoubaoAdapter()
}
