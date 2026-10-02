import fs from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, onTestFinished, vi } from 'vitest'
import { runnerTest as it } from './fullBundle.utils'

describe(
  'module runner hmr works as expected',
  async () => {
    it.override('config', {
      server: {
        // override watch options because it's disabled by default
        watch: {},
        hmr: true,
      },
    })

    it('hmr options are defined', async ({ runner }) => {
      expect(runner.hmrClient).toBeDefined()

      const mod = await runner.import('/fixtures/hmr.js')
      expect(mod).toHaveProperty('hmr')
      expect(mod.hmr).toHaveProperty('accept')
    })

    it('correctly populates hmr client', async ({ runner }) => {
      const mod = await runner.import('/fixtures/d')
      expect(mod.d).toBe('a')

      const fixtureC = '/fixtures/c.ts'
      const fixtureD = '/fixtures/d.ts'

      expect(runner.hmrClient!.hotModulesMap.size).toBe(2)
      expect(runner.hmrClient!.dataMap.size).toBe(2)
      expect(runner.hmrClient!.ctxToListenersMap.size).toBe(2)

      for (const fixture of [fixtureC, fixtureD]) {
        expect(runner.hmrClient!.hotModulesMap.has(fixture)).toBe(true)
        expect(runner.hmrClient!.dataMap.has(fixture)).toBe(true)
        expect(runner.hmrClient!.ctxToListenersMap.has(fixture)).toBe(true)
      }
    })

    it('does not expose partial exports during concurrent updates', async ({
      runner,
    }) => {
      const testGlobal = globalThis as any

      testGlobal.__vite_ssr_hmr_reexport_race__ = {
        wait: () => Promise.resolve(),
      }
      onTestFinished(() => {
        delete testGlobal.__vite_ssr_hmr_reexport_race__
      })

      await runner.import('/fixtures/hmr-reexport-race/entry-a.js')
      await runner.import('/fixtures/hmr-reexport-race/entry-b.js')

      const sharedModule = runner.evaluatedModules.getModuleByUrl(
        '/fixtures/hmr-reexport-race/shared.js',
      )
      const coreModule = runner.evaluatedModules.getModuleByUrl(
        '/fixtures/hmr-reexport-race/core.js',
      )
      const entryAModule = runner.evaluatedModules.getModuleByUrl(
        '/fixtures/hmr-reexport-race/entry-a.js',
      )
      const entryBModule = runner.evaluatedModules.getModuleByUrl(
        '/fixtures/hmr-reexport-race/entry-b.js',
      )
      expect(sharedModule).toBeDefined()
      expect(coreModule).toBeDefined()
      expect(entryAModule).toBeDefined()
      expect(entryBModule).toBeDefined()

      let waitStarted!: () => void
      const waitStartedPromise = new Promise<void>((resolve) => {
        waitStarted = resolve
      })
      let releaseWait!: () => void
      const waitPromise = new Promise<void>((resolve) => {
        releaseWait = resolve
      })

      testGlobal.__vite_ssr_hmr_reexport_race__ = {
        wait: () => {
          waitStarted()
          return waitPromise
        },
      }

      for (const module of [
        entryAModule!,
        entryBModule!,
        sharedModule!,
        coreModule!,
      ]) {
        runner.evaluatedModules.invalidateModule(module)
      }

      const importA = runner.import('/fixtures/hmr-reexport-race/entry-a.js')
      await waitStartedPromise

      const importB = runner.import('/fixtures/hmr-reexport-race/entry-b.js')
      // Wait deterministically until entry-b has reached the point where it
      // observes shared as in-flight. The `mod.imports.add(depMod.id)` line
      // in `request()` runs synchronously immediately before `cachedRequest`
      // executes its cycle-detection prefix, so observing this edge means
      // the buggy/fixed branch has either just run or is about to run on
      // the same microtask. `imports` is cleared by invalidateModule, so
      // this is a fresh signal (unlike `importers`, which is preserved).
      const entryBNode = runner.evaluatedModules.getModuleByUrl(
        '/fixtures/hmr-reexport-race/entry-b.js',
      )!
      while (!entryBNode.imports.has(sharedModule!.id)) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      releaseWait()
      const results = await Promise.allSettled([importA, importB] as const)

      expect(results).toEqual([
        {
          status: 'fulfilled',
          value: expect.objectContaining({ result: 'a' }),
        },
        {
          status: 'fulfilled',
          value: expect.objectContaining({ result: 'b' }),
        },
      ])

      const hmrListeners = runner.hmrClient!.hotModulesMap
      expect(hmrListeners.has('/fixtures/hmr-reexport-race/entry-a.js')).toBe(
        true,
      )
      expect(hmrListeners.has('/fixtures/hmr-reexport-race/entry-b.js')).toBe(
        true,
      )
    })

    describe('full bundle mode', () => {
      it.override('fullBundle', ['./fixtures/simple-hmr.js'])
      it.override('config', {
        server: {
          hmr: true,
          watch: {},
        },
      })

      it('the exports object is updated', async ({ runner }) => {
        const exports1 = await runner.import('/fixtures/simple-hmr.js')

        expect(exports1).toHaveProperty('test', 'I am initialized')
        expect(exports1).not.toHaveProperty('hmr')

        const hmrCode = `\nexport const hmr = true;globalThis.__HMR_PROMISE__.resolve()`

        editFile('./fixtures/simple-hmr.js', (code) => code + hmrCode)
        onTestFinished(() => {
          ;(globalThis as any).__HMR_PROMISE__ = undefined
          editFile('./fixtures/simple-hmr.js', (code) =>
            code.replace(hmrCode, ''),
          )
        })

        await (globalThis as any).__HMR_PROMISE__

        const exports2 = await runner.import('/fixtures/simple-hmr.js')
        expect(exports2).toMatchObject({
          test: 'I am initialized',
          hmr: true,
        })
      })
    })

    describe('full bundle mode after the runner cache is cleared', () => {
      it.override('fullBundle', ['./fixtures/hmr-session/entry.js'])
      it.override('config', {
        server: {
          hmr: true,
          watch: {},
        },
      })

      it('a later edit is still applied as a hot update', async ({
        runner,
        environment,
      }) => {
        const entry = '/fixtures/hmr-session/entry.js'
        const editDep = (from: string, to: string) =>
          editFile('./fixtures/hmr-session/dep.js', (code) =>
            code.replace(from, to),
          )
        const expectValue = (value: string) =>
          vi.waitFor(async () => {
            expect((await runner.import(entry)).value).toBe(value)
          })
        onTestFinished(() => {
          editFile(
            './fixtures/hmr-session/dep.js',
            () => `export const value = 'initial'\n`,
          )
        })
        await expectValue('initial')

        // the patch gives the runner the factory of the accepting importer
        editDep('initial', 'first')
        await expectValue('first')

        await environment.bundledDev!.devEngine.ensureLatestBuildOutput()
        runner.clearCache()
        await expectValue('first')

        const debug = vi.spyOn(runner.hmrClient!.logger, 'debug')
        editDep('first', 'second')
        await expectValue('second')
        expect(debug.mock.calls.flat().join('\n')).not.toContain(
          'full reload needed',
        )
      })
    })
  },
  process.env.CI ? 50_00 : 5_000,
)

function editFile(file: string, callback: (content: string) => string) {
  const filepath = resolve(import.meta.dirname, file)
  const content = fs.readFileSync(filepath, 'utf-8')
  fs.writeFileSync(filepath, callback(content), 'utf-8')
}
