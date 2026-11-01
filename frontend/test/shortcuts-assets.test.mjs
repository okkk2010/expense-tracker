import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const frontend = new URL('../', import.meta.url)
const signed = new URL('../shortcuts/signed/', frontend)

test('public shortcut downloads contain the verified signed artifacts', async () => {
  const report = JSON.parse(await readFile(new URL('signing-report.json', signed), 'utf8'))
  const verified = JSON.parse(await readFile(new URL('verification-report.json', signed), 'utf8'))
  for (const name of ['moa-toss.shortcut', 'moa-kb.shortcut']) {
    const source = await readFile(new URL(name, signed))
    const download = await readFile(new URL(`public/shortcuts/${name}`, frontend))
    assert.deepEqual(download, source, `${name} must serve the signed file, not an HTML fallback`)
    assert.equal(download.subarray(0, 4).toString(), 'AEA1')
    assert.equal(createHash('sha256').update(download).digest('hex'), report.artifacts.find(item => item.file === name).signed_sha256)
    assert.equal(verified.files[name].verification_passed, true)
    assert.equal(verified.files[name].all_actions_and_parameters_match, true)
    assert.equal(verified.files[name].import_questions_match, true)
  }
})

test('Vercel serves shortcut files as downloads and never sends missing files to the app shell', async () => {
  const config = JSON.parse(await readFile(new URL('vercel.json', frontend), 'utf8'))
  const rule = config.headers.find(item => item.source === '/shortcuts/:path*')
  assert.ok(rule)
  const headers = Object.fromEntries(rule.headers.map(item => [item.key.toLowerCase(), item.value]))
  assert.equal(headers['content-type'], 'application/octet-stream')
  assert.match(headers['content-disposition'], /^attachment(?:;|$)/)
  assert.match(headers['cache-control'], /must-revalidate/)
  const appShell = config.rewrites.find(item => item.destination === '/index.html')
  const matchesAppShell = new RegExp(`^${appShell.source}$`)
  for (const path of ['/shortcuts', '/shortcuts/moa-toss.shortcut', '/shortcuts/moa-kb.shortcut', '/shortcuts/missing.shortcut', '/api/shortcuts/ingest']) {
    assert.equal(matchesAppShell.test(path), false, path)
  }
  assert.equal(matchesAppShell.test('/settings'), true)
})
