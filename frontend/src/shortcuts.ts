const endpointError = '수집 주소를 만들 수 없어요. /api 또는 사용자 정보·쿼리·해시가 없는 http://, https:// 서버 주소를 사용해 주세요.'

export function shortcutIngestEndpoint(configuredApi: string, pageOrigin: string): string {
  const base = configuredApi.trim().replace(/\/+$/, '')
  if (!base || /[\u0000-\u0020\u007f?#]/.test(base)) throw new Error(endpointError)
  try {
    let url: URL
    if (base === '/api') {
      const page = new URL(pageOrigin)
      if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password || page.search || page.hash) throw new Error(endpointError)
      url = new URL('/api', page.origin)
    } else {
      if (!/^https?:\/\//i.test(base)) throw new Error(endpointError)
      url = new URL(base)
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error(endpointError)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/shortcuts/ingest`
    return url.href
  } catch { throw new Error(endpointError) }
}

export function activeShortcutAccounts<T extends { archived?: boolean }>(accounts: readonly T[]): T[] {
  return accounts.filter(account => !account.archived)
}
