import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(path.join(root, 'artifacts'), { recursive: true })
const directory = await mkdtemp(path.join(root, 'artifacts/package-test-'))
try {
  const packOutput = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' })
  // npm 10/11 may print lifecycle/prepare logs before the JSON payload.
  let packed
  for (let offset = packOutput.indexOf('['); offset >= 0; offset = packOutput.indexOf('[', offset + 1)) {
    try {
      const candidate = JSON.parse(packOutput.slice(offset))
      if (Array.isArray(candidate) && candidate[0]?.files !== undefined) { packed = candidate[0]; break }
    } catch { /* npm lifecycle output can contain bracketed log text */ }
  }
  assert.ok(packed !== undefined, `npm pack did not return JSON: ${packOutput.slice(-500)}`)
  const files = packed.files.map(file => file.path)
  assert.ok(files.includes('lib/index.js') && files.includes('lib/client.js'))
  assert.ok(files.includes('cordis.patch.yml'))
  assert.equal(files.some(file => file.startsWith('src/') || file.startsWith('docs/') || /\.(?:map|tsx?|css)$/.test(file)), false, 'package contains no sources or source maps')
  assert.equal(files.some(file => file.startsWith('scripts/') || file.startsWith('artifacts/')), false, 'package contains no repository tooling')
  execFileSync('tar', ['-xzf', path.join(directory, packed.filename), '-C', directory])
  const home = path.join(directory, 'data')
  process.env.DSH_HOME = home
  const host = await import(pathToFileURL(path.join(directory, 'package/lib/index.js')).href)
  for (const source of ['vibeui', 'canghe', 'handraw', 'prompt-signal', 'evolink', 'image-prompts']) {
    const list = await host.listTemplates(source)
    assert.equal(list.origin, 'bundled')
    assert.ok(list.cases.length > 0, `${source} snapshot loads without src directory`)
  }
  for (const file of files.filter(file => file.endsWith('.js'))) {
    assert.equal((await readFile(path.join(directory, 'package', file), 'utf8')).includes('sourceMappingURL='), false)
  }
  assert.ok((await readFile(path.join(directory, 'package/lib/client.js'), 'utf8')).includes('@superdsh/dsh-imagegen'))
  console.log('PACKAGE TEST OK: real tgz; no src/docs/maps; six bundled template sources load; client entry present')
} finally {
  await rm(directory, { recursive: true, force: true })
}
