import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'

import fg from 'fast-glob'
import { resolve } from 'resolve.exports'
import { rollup } from '@rollup/browser'
import { Generator } from '@jspm/generator'
import { composeTwoImportMaps } from '@jsenv/importmap'
import { dataToEsm } from '@rollup/pluginutils'

import { sveltekit } from '@sveltejs/kit/vite'
import { searchForWorkspaceRoot, defineConfig, transformWithEsbuild, send } from 'vite'

import commonjs from '@rollup/plugin-commonjs'
import nodePolyfills from 'rollup-plugin-polyfill-node'

import { version as VERSION } from './package.json'

export default defineConfig((env) => {
  const cdn = new Map<string, string | Buffer>()
  const root = `_app/`

  return {
    plugins: [
      sveltekit(),
      {
        name: 'generate-cdn',
        async buildStart() {
          cdn.clear()

          const isProd = env.mode === 'production'

          const emitFile = (fileName: string, source: string | Buffer | Uint8Array) => {
            cdn.set(
              fileName.slice(root.length - 1),
              typeof source === 'string' || Buffer.isBuffer(source) ? source : Buffer.from(source),
            )
            if (env.command === 'build') {
              this.emitFile({ type: 'asset', fileName, source })
            }
          }
          // bundle current packages and generate resolutions fro @jsbpm/generator
          // TODO: refactor to cdn.twind.style

          // 1. find all packages
          //   - in dev use packages/*/package.json
          //   - in prod use packages/*/dist/package.json
          const files = await fg(
            [
              `../../packages/*/${process.env.CI ? 'dist/' : ''}package.json`,
              '!**/{cdn,with-*,*-plugin}/**',
            ],
            { absolute: true },
          )

          const conditions = [
            'development',
            'modern',
            'esmodules',
            'es0215',
            'module',
            'import',
            'default',
          ]

          const packages = await Promise.all(
            files.map(async (manifestFile) => {
              // 2. generate systemjs bundle with rollup for all entry points
              //   - https://www.npmjs.com/package/resolve.exports

              const manifest = JSON.parse(await fs.readFile(manifestFile, { encoding: 'utf8' }))
              manifest.exports = {
                './package.json': './package.json',
                ...(manifest.exports || {
                  '.': manifest.source || manifest.esnext || manifest.module || manifest.main,
                }),
              }

              const exports = Object.keys(manifest.exports)
                .map((entry) => {
                  const resolved = resolve(manifest, entry, { conditions })

                  if (!resolved) {
                    // ignore
                    return
                  }

                  const file = path.resolve(path.dirname(manifestFile), resolved)
                  return { entry, resolved, file }
                })
                .filter(<T>(value: T): value is Exclude<T, undefined | null> => value != undefined)

              const external = new Set<string>()

              const bundle = await rollup({
                input: Object.fromEntries(
                  exports
                    .filter((input) => /\.[mc]?[jt]sx?$/.test(input.resolved))
                    .map((input) => [
                      input.entry === '.' ? manifest.name.split('/').pop() : input.entry.slice(2),
                      input.resolved,
                    ]),
                ),
                onwarn(warning, handler) {
                  if (warning.code !== 'CIRCULAR_DEPENDENCY') {
                    handler(warning)
                  }
                },
                plugins: [
                  {
                    name: 'virtual',
                    resolveId(source, importer, { isEntry }) {
                      if (isEntry) {
                        const input = exports.find((input) => input.resolved === source)
                        return input?.file
                      }

                      if (importer && source.startsWith('.')) {
                        const base = path.resolve(path.dirname(importer), source)
                        const extensions = [
                          '',
                          '.tsx',
                          '.jsx',
                          '.mts',
                          '.ts',
                          '.mjs',
                          '.js',
                          '.cts',
                          '.cjs',
                          '.json',
                        ]
                        return Promise.resolve(0).then(async function find(
                          index,
                        ): Promise<string | { id: string; external: boolean }> {
                          const ext = extensions[index]

                          if (ext == null) {
                            external.add(source)
                            return { id: source, external: true }
                          }

                          try {
                            await fs.access(base + ext)
                            return base + ext
                          } catch {
                            return find(index + 1)
                          }
                        })
                      }

                      if (source === 'distilt/env') {
                        const manifestFile = createRequire(importer || import.meta.url).resolve(
                          'distilt/package.json',
                        )

                        return fs
                          .readFile(manifestFile, { encoding: 'utf8' })
                          .then((raw) => JSON.parse(raw))
                          .then((manifest) => {
                            const resolved = resolve(manifest, './env', { conditions })
                            if (!resolved) {
                              external.add(source)

                              return { id: source, external: true }
                            }

                            return path.resolve(path.dirname(manifestFile), resolved)
                          })
                      }

                      external.add(source)

                      return { id: source, external: true }
                    },
                    async load(id) {
                      const content = await fs.readFile(id, { encoding: 'utf8' })

                      if (id.endsWith('.json')) {
                        // TODO: named exports
                        return dataToEsm(JSON.parse(content), {
                          compact: isProd,
                          indent: isProd ? '' : '\t',
                          preferConst: true,
                          objectShorthand: true,
                          namedExports: true,
                        })
                      }

                      return content
                    },
                  },
                  {
                    name: 'esbuild',
                    transform(code, id) {
                      return transformWithEsbuild(code, id, {
                        format: 'esm',
                        minify: isProd,
                        sourcemap: 'external',
                        platform: 'browser',
                        // https://github.com/vitejs/vite/blob/main/packages/vite/src/node/constants.ts#L14
                        target: [
                          'es2020', // support import.meta.url
                          'edge88',
                          'firefox78',
                          'chrome87',
                          'safari13', // transpile nullish coalescing
                        ],
                      })
                    },
                  },
                ],
              })

              // bundle.watchFiles

              // 3. emit assets (add immutable cache-header in dev)
              //   - file: `this.emitFile({ type: 'asset', fileName: '-/cdn/<package>@<version>/<resolvedname>', source: code })})`
              //   - map: `this.emitFile({ type: 'asset', fileName: '-/cdn/<package>@<version>/<resolvedname>.map', source: map.toString() })})`
              const { output } = await bundle.generate({
                format: 'systemjs',
                generatedCode: 'es2015',
                sourcemap: true,
                compact: isProd,
                chunkFileNames: '_[hash].js',
              })

              await bundle.close()

              const prefix = `immutable/cdn/${manifest.name}@${manifest.version}/`
              const mapping: Record<string, string> = {}

              for (const chunk of output) {
                if (chunk.type === 'asset') {
                  emitFile(root + prefix + chunk.fileName, chunk.source)
                } else {
                  const input =
                    chunk.isEntry && exports.find((input) => input.file === chunk.facadeModuleId)

                  if (input) {
                    // name/
                    mapping[manifest.name + input.entry.slice(1)] = './' + prefix + chunk.fileName
                    manifest.exports[input.entry] = './' + chunk.fileName
                    // name@version/
                    // mapping[prefix.slice(0, -1) + (input.entry === '.' ? '' : '/' + chunk.name)] =
                    //   './' + prefix + chunk.fileName
                  }

                  emitFile(root + prefix + chunk.fileName, chunk.code)
                }
              }

              await Promise.all(
                exports
                  .filter((input) => !/\.[mc]?[jt]sx?$/.test(input.resolved))
                  .map(async (input) => {
                    // name/
                    mapping[manifest.name + '/' + input.entry.slice(2)] =
                      './' + prefix + input.entry.slice(2)
                    // name@version/
                    // mapping[prefix.slice(0, -1) + '/' + input.entry.slice(2)] = './' + prefix + input.entry.slice(2)

                    emitFile(
                      root + prefix + input.entry.slice(2),
                      input.file === './package.json'
                        ? JSON.stringify(manifest, null, isProd ? undefined : 2)
                        : await fs.readFile(input.resolved, { encoding: 'utf8' }),
                    )
                  }),
              )

              return {
                url: pathToFileURL(manifestFile),
                manifest,
                prefix,
                exports,
                mapping,
                external,
              }
            }),
          )

          // 3. emit inputMap (application/importmap+json) with relative paths
          //   - file: `this.emitFile({ type: 'asset', fileName: '-/cdn/importmap.json', source: code })})`

          const scoped = await Promise.all(
            packages.map(async ({ url, prefix, external, manifest }) => {
              const generator: Generator = new Generator({
                // Set the map URL for relative normalization when installing local packages
                mapUrl: url,
                defaultProvider: 'jspm.system',
                env: conditions,
              })

              const versions = {
                ...manifest.devDependencies,
                ...manifest.peerDependencies,
                ...manifest.dependencies,
              }

              const result = await generator.install(
                await Promise.all(
                  [...external].map(async (specifier) => {
                    const match = specifier.match(/^((?:@[^\s/]+\/)?[^\s/@]+)(\/[^\s/@]+)?$/)

                    if (!match) return specifier

                    const { 1: id, 2: path = '' } = match

                    try {
                      const { version } = JSON.parse(
                        await fs.readFile(
                          new URL(`./node_modules/${id}/package.json`, url),
                          'utf8',
                        ),
                      )
                      return version ? `${id}@${version}${path}` : id + path
                    } catch {
                      const version = versions[id]

                      return version ? `${id}@${version}${path}` : id + path
                    }
                  }),
                ),
              )

              // const pkgUrl = await getPackageBase('https://ga.jspm.io/npm:lit-element@2.5.1/lit-element.js');
              return {
                prefix,
                importMap: generator.importMap,
                ...(result || { staticDeps: [], dynamicDeps: [] }),
              }
            }),
          )

          let importMap = {
            imports: Object.fromEntries(packages.flatMap(({ mapping }) => Object.entries(mapping))),
          }

          // const deps = new Set<string>()
          for (const scope of scoped) {
            const imports = Object.entries(scope.importMap.imports).filter(
              ([key]) => !importMap.imports.hasOwnProperty(key),
            )

            if (imports.length) {
              importMap = composeTwoImportMaps(importMap, {
                scopes: {
                  ['./' + scope.prefix]: Object.fromEntries(imports),
                },
              })
            }

            const scopes = scope.importMap.scopes
            // const scopes = Object.entries(scope.importMap.scopes).map(([scope, mapping]) => [
            //   scope.replace('https://ga.system.jspm.io/npm:', './'),
            //   Object.fromEntries(
            //     Object.entries(mapping).map(([key, value]) => [
            //       key,
            //       value.replace('https://ga.system.jspm.io/npm:', './'),
            //     ]),
            //   ),
            // ])

            if (scopes) {
              importMap = composeTwoImportMaps(importMap, { scopes })
            }

            // for (const dep of [...scope.staticDeps, ...scope.staticDeps]) {
            //   deps.add(dep)
            // }
          }

          // await Promise.all(
          //   Array.from(deps, async (dep) => {
          //     const fileName = dep.replace('https://ga.system.jspm.io/npm:', '-/cdn/')
          //     if (!cdn.has(fileName)) {
          //       const response = await fetch(dep)

          //       if (!(response.ok && response.status === 200)) {
          //         throw new Error(`Failed to fetch ${dep}`)
          //       }

          //       emitFile(fileName, await response.text())

          //       // try to load the sourcemap - TODO: extract from source text
          //       await fetch(dep + '.map')
          //         .then(async (response) => {
          //           if (!(response.ok && response.status === 200)) {
          //             throw new Error(`Failed to fetch ${dep}`)
          //           }

          //           emitFile(fileName + '.map', await response.text())
          //         })
          //         .catch(() => {
          //           /* ignore */
          //         })
          //     }
          //   }),
          // )

          const manifestData = {
            // from version: 1.0.0 -> latest, 1.0.0-(next|canary)-*
            version: VERSION,
            'dist-tag': VERSION.replace(/^1.0.0(?:-([^.-]+).+)?$/, '$1') || 'latest',
            'git-sha': process.env.GITHUB_SHA || execSync('git rev-parse HEAD').toString().trim(),
            pr:
              process.env.GITHUB_EVENT_NAME === 'pull_request'
                ? execSync('jq --raw-output .pull_request.number "$GITHUB_EVENT_PATH"')
                    .toString()
                    .trim()
                : undefined,
            ...importMap,
            packages: Object.fromEntries(
              packages.map(({ manifest }) => [manifest.name, manifest.version]),
            ),
          }

          console.debug({
            ...manifestData,
            // cdn: [...cdn.keys()],
          })

          emitFile(root + 'cdn.json', JSON.stringify(manifestData, null, isProd ? undefined : 2))
        },
        configureServer(server) {
          server.middlewares.use('/' + root, (req, res, next) => {
            const content = req.url && cdn.get(req.url)
            if (content != null) {
              let type = path.extname(req.url as string)
              if (type.startsWith('.')) {
                type = type.slice(1)
              }

              if (type === 'map') {
                type = 'json'
              }

              if (/^[mc]?[jt]sx?$/.test(type)) {
                type = 'js'
              }

              return send(req, res, content, type, {
                headers: server.config.server.headers,
              })
            }

            console.debug('not found', req.url, cdn.keys())
            next()
          })
        },
      },
    ],

    resolve: {
      // no browser condition because this is sometimes used for umd builds
      exportConditions: [
        env.mode,
        'esnext',
        'modern',
        'esmodules',
        'es2015',
        'module',
        'import',
        'require',
        'default',
        env.ssrBuild && 'node',
      ].filter(Boolean),
    },

    worker: {
      format: env.mode === 'development' ? 'es' : 'iife',
      plugins: [
        {
          name: 'fix-umd-imports',
          enforce: 'pre',
          resolveId(source, importer, options) {
            return this.resolve(source, importer, { ...options, skipSelf: true }).then(
              (resolved) => {
                if (resolved.id?.includes('/@jridgewell/') && resolved.id.endsWith('.umd.js')) {
                  resolved.id = resolved.id.replace(/\.umd\.js$/, '.mjs')
                }
                return resolved
              },
            )
          },
        },
        env.mode !== 'development' &&
          commonjs({
            sourceMap: false,
          }),
        env.mode !== 'development' &&
          nodePolyfills({
            // transform all files, including all files including any source files
            include: null,
          }),
        {
          name: 'resolve-to-location',
          resolveFileUrl({ fileName }) {
            return `new URL('${fileName}',location.href).href`
          },
        },
      ].filter(Boolean),
      rollupOptions: {
        output: {
          inlineDynamicImports: env.mode !== 'development',
        },
      },
    },

    clearScreen: false,

    server: {
      fs: {
        // search up for workspace root
        allow: [searchForWorkspaceRoot(process.cwd())],
      },
      watch: {
        ignored: [fileURLToPath(new URL('.mf/**', import.meta.url))],
      },
    },
  }
})