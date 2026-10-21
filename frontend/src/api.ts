import type { Connection } from './types'

const defaultUrl = import.meta.env.VITE_API_URL || '/api'
export function getConnection(): Connection {
  try { return { url: localStorage.getItem('moa.api') || defaultUrl, token: localStorage.getItem('moa.token') || '' } }
  catch { return {url: defaultUrl, token: ''} }
}
export function saveConnection(connection: Connection) {
  const url = connection.url.trim().replace(/\/+$/, '')
  if (url !== '/api') {
    let valid = false
    try { valid = ['http:', 'https:'].includes(new URL(url).protocol) } catch { /* Show the same guidance for invalid URLs. */ }
    if (!valid) throw new Error('/api 또는 http://, https://로 시작하는 서버 주소를 입력해 주세요.')
  }
  localStorage.setItem('moa.api', url)
  localStorage.setItem('moa.token', connection.token.trim())
}
export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, detail: unknown) {
    const object = detail as {message?: string}
    super(typeof detail === 'string' ? detail : object?.message || '요청을 처리하지 못했습니다.')
    this.status = status; this.detail = detail
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const {url, token} = getConnection()
  const controller = new AbortController()
  const callerSignal = init.signal
  const cancelFromCaller = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener('abort', cancelFromCaller, {once:true})
  const timeout = setTimeout(() => controller.abort(), path === '/analysis' ? 120000 : 20000)
  try {
    const headers = new Headers(init.headers)
    if (init.body) headers.set('Content-Type', 'application/json')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, {...init, headers, signal: controller.signal})
    if (!response.ok) {
      const body = await response.json().catch(() => ({detail: '서버 응답을 읽을 수 없습니다.'}))
      if (response.status === 401 || response.status === 403) throw new ApiError(response.status, '개인 접속키를 확인해 주세요. 설정에서 연결 정보를 바꿀 수 있습니다.')
      throw new ApiError(response.status, body.detail ?? body)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('서버 응답이 늦어지고 있습니다. 잠시 후 다시 시도해 주세요.')
    throw new Error('서버에 연결할 수 없습니다. 서버 주소와 인터넷 연결을 확인해 주세요.')
  } finally { clearTimeout(timeout); callerSignal?.removeEventListener('abort', cancelFromCaller) }
}
export const json = (value: unknown) => JSON.stringify(value)
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '처리 중 문제가 발생했습니다.'
