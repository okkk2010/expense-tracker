import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const source = await readFile(new URL('../src/shortcuts.ts', import.meta.url), 'utf8')
const { shortcutIngestEndpoint, activeShortcutAccounts } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
const productionOrigin = 'https://expense-tracker-lake-eight-39.vercel.app'

test('same-origin /api creates an absolute iPhone URL through the deployed HTTPS proxy', () => {
  assert.equal(shortcutIngestEndpoint('/api', productionOrigin), `${productionOrigin}/api/shortcuts/ingest`)
  assert.equal(shortcutIngestEndpoint(' /api/ ', productionOrigin), `${productionOrigin}/api/shortcuts/ingest`)
  assert.equal(shortcutIngestEndpoint('/api', 'http://127.0.0.1:5173'), 'http://127.0.0.1:5173/api/shortcuts/ingest')
})

test('explicit backend URLs retain origin, port and API path without depending on the frontend origin', () => {
  assert.equal(shortcutIngestEndpoint('https://private.example.com/v1/api/', productionOrigin), 'https://private.example.com/v1/api/shortcuts/ingest')
  assert.equal(shortcutIngestEndpoint('http://192.168.1.5:8000/api', productionOrigin), 'http://192.168.1.5:8000/api/shortcuts/ingest')
  assert.equal(shortcutIngestEndpoint('https://backend.example.com', productionOrigin), 'https://backend.example.com/shortcuts/ingest')
})

test('shortcut URLs cannot accidentally copy credentials, query secrets, fragments or unsupported schemes', () => {
  for (const value of ['', '/wrong', '//other.example/api', 'example.com/api', 'https:example.com/api', 'ftp://example.com/api', 'javascript:alert(1)', 'https://user:secret@example.com/api', 'https://example.com/api?token=secret', 'https://example.com/api#secret', 'https://example.com/api?', 'https://example.com/api#', 'https://example.com/a\npi', 'https://example.com/a pi']) {
    assert.throws(() => shortcutIngestEndpoint(value, productionOrigin), /수집 주소를 만들 수 없어요/)
  }
  assert.throws(() => shortcutIngestEndpoint('/api', 'file:///local/app'), /수집 주소를 만들 수 없어요/)
})

test('archived instruments stay available to history while being excluded from new import mappings', () => {
  const accounts = [{ id: 'old-card', archived: true }, { id: 'kb-bank', archived: false }, { id: 'legacy-account' }]
  assert.deepEqual(activeShortcutAccounts(accounts).map(account => account.id), ['kb-bank', 'legacy-account'])
  assert.equal(accounts.length, 3)
  assert.equal(accounts[0].id, 'old-card')
  assert.deepEqual(activeShortcutAccounts([{ id: 'archived-only', archived: true }]), [])
})
