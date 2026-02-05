/* Offline-Core API rewriter service worker
 *
 * Rewrites essential Curve API GET requests to a static snapshot base URL that you publish to IPFS daily.
 * This keeps core on-chain actions usable even if Curve infrastructure is down.
 *
 * Static snapshot contract:
 *   ${BASE}/{hostname}{normalizedPath}
 *
 * Examples:
 *   ${BASE}/api.curve.finance/api/getPools/ethereum/main
 *   ${BASE}/api-core.curve.finance/v1/getPlatforms
 *   ${BASE}/prices.curve.finance/v1/lending/markets
 *
 * Query-string note:
 *   IPFS cannot serve different static files for different querystrings. We only support the minimal
 *   query mappings needed for DAO proposals; everything else with a querystring is rejected.
 */

const CACHE_NAME = 'offline-core-static-data-v2'
const APP_SHELL_CACHE = 'offline-core-app-shell-v2'

const REWRITE_HOSTS = new Set(['api.curve.finance', 'api-core.curve.finance', 'prices.curve.finance'])

const BLOCKED_HOSTS = new Set(['api.coingecko.com', 'api.merkl.xyz', 'api-py.llama.airforce', 'yields.llama.fi'])

const STATIC_DATA_BASE_URL = (() => {
  try {
    return new URL(self.location.href).searchParams.get('base') || ''
  } catch {
    return ''
  }
})()

function normalizePath(pathname) {
  // Keep leading slash; collapse accidental double slashes coming from deps.
  return (pathname || '/').replace(/\/{2,}/g, '/')
}

function stripTrailingSlashes(s) {
  return (s || '').replace(/\/+$/, '')
}

function joinStaticUrl(base, hostname, pathname) {
  const baseNoTrailing = stripTrailingSlashes(base)
  return `${baseNoTrailing}/${hostname}${pathname}`
}

function jsonError(status, error, details) {
  return new Response(JSON.stringify({ error, ...(details ? { details } : {}) }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function isHtmlResponse(resp) {
  const ct = (resp && resp.headers && resp.headers.get('content-type')) || ''
  return ct.includes('text/html')
}

function jsonOk(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyGetPoolsResponse() {
  // Matches Curve API /getPools data access patterns (Curve-JS reads `json.data`).
  return jsonOk({ success: true, data: { poolData: [], tvl: 0, tvlAll: 0 } })
}

function emptyGetPoolListResponse() {
  return jsonOk({ success: true, data: { poolList: [] } })
}

function emptyGetVolumesResponse() {
  return jsonOk({
    success: true,
    data: { pools: [], totalVolumes: { totalVolume: 0, totalCryptoVolume: 0, cryptoVolumeSharePcent: 0 } },
  })
}

function emptyGetSubgraphDataResponse() {
  return jsonOk({ success: true, data: { poolList: [], totalVolume: 0, cryptoVolume: 0, cryptoShare: 0 } })
}

function emptyGetFactoryApysResponse() {
  return jsonOk({ success: true, data: { poolDetails: [], totalVolumeUsd: 0, totalVolume: 0 } })
}

function getStubResponse(hostname, pathname) {
  if (pathname.startsWith('/api/getPools/') || pathname.startsWith('/v1/getPools/')) return emptyGetPoolsResponse()
  if (hostname === 'api.curve.finance' && pathname.startsWith('/v1/getPoolList/')) return emptyGetPoolListResponse()

  if (hostname === 'api.curve.finance') {
    if (pathname.startsWith('/api/getVolumes/')) return emptyGetVolumesResponse()
    if (pathname.startsWith('/api/getSubgraphData/')) return emptyGetSubgraphDataResponse()
    if (pathname.startsWith('/api/getFactoryAPYs/')) return emptyGetFactoryApysResponse()
  }

  return null
}

async function maybeStubAndCache(cache, rewrittenUrl, hostname, pathname, resp) {
  const stub = getStubResponse(hostname, pathname)
  if (!stub) return null

  // Snapshot files may be served as `text/plain` (still valid JSON). Only stub when it's actually missing/broken.
  const shouldStub = !resp || !resp.ok || isHtmlResponse(resp)
  if (!shouldStub) return null

  try {
    await cache.put(rewrittenUrl, stub.clone())
  } catch {
    // ignore cache failures (quota, etc)
  }

  return stub
}

function looksLikeFilePath(pathname) {
  const last = (pathname || '').split('/').filter(Boolean).pop() || ''
  return last.includes('.')
}

async function getAppShell() {
  const cache = await caches.open(APP_SHELL_CACHE)
  const scopeUrl = self.registration.scope
  const cached = await cache.match(scopeUrl)
  if (cached) return cached

  const resp = await fetch(scopeUrl, { cache: 'no-store' })
  if (resp && resp.ok) {
    void cache.put(scopeUrl, resp.clone())
  }
  return resp
}

function mapQueryUrl(url) {
  const pathname = normalizePath(url.pathname)

  // prices.curve.finance DAO proposals: query pagination -> path-based snapshot
  if (url.hostname === 'prices.curve.finance' && pathname === '/v1/dao/proposals') {
    const page = url.searchParams.get('page') || '1'
    if (!/^\d+$/.test(page)) return { error: 'unsupported_query' }
    return { pathname: `/v1/dao/proposals/pages/${page}` }
  }

  // Strip tx_hash from details requests
  if (url.hostname === 'prices.curve.finance' && pathname.startsWith('/v1/dao/proposals/details/')) {
    return { pathname }
  }

  return { error: 'unsupported_query' }
}

async function cacheFirst(rewrittenUrl) {
  const cache = await caches.open(CACHE_NAME)

  const fetchAndCache = async () => {
    let resp
    try {
      resp = await fetch(rewrittenUrl, { cache: 'no-store' })
    } catch (e) {
      return jsonError(503, 'offline-core-unavailable', `Failed fetching static data: ${String(e)}`)
    }

    if (resp && resp.ok && !isHtmlResponse(resp)) {
      void cache.put(rewrittenUrl, resp.clone())
    }

    return resp
  }

  const cached = await cache.match(rewrittenUrl)
  if (cached) return cached

  return await fetchAndCache()
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // SPA fallback for gateways that do not rewrite deep routes to index.html.
  // This only helps after the SW is installed/controlling; initial deep-link loads still need a compatible gateway.
  if (req.method === 'GET' && req.mode === 'navigate' && url.origin === self.location.origin) {
    // Don't hijack navigations to known files.
    if (!looksLikeFilePath(url.pathname)) {
      event.respondWith(
        (async () => {
          try {
            const networkResp = await fetch(req)
            if (networkResp && networkResp.ok) return networkResp
          } catch {
            // ignore and fall back to app shell
          }
          const shell = await getAppShell()
          if (shell && shell.ok) return shell
          return jsonError(503, 'offline-core-unavailable', 'Failed loading app shell')
        })(),
      )
      return
    }
  }

  // Block local router backend + error reporting in Offline-Core.
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/api/router') || url.pathname.startsWith('/api/error-report'))
  ) {
    event.respondWith(jsonError(503, 'offline-core-disabled', 'Endpoint disabled in Offline-Core'))
    return
  }

  if (BLOCKED_HOSTS.has(url.hostname)) {
    event.respondWith(jsonError(503, 'offline-core-disabled', `Blocked host: ${url.hostname}`))
    return
  }

  // Only rewrite essential Curve API GETs.
  if (REWRITE_HOSTS.has(url.hostname)) {
    if (req.method !== 'GET') {
      event.respondWith(jsonError(503, 'offline-core-disabled', 'Only GET is supported in Offline-Core'))
      return
    }

    if (!STATIC_DATA_BASE_URL) {
      event.respondWith(jsonError(503, 'offline-core-misconfigured', 'Missing static data base URL'))
      return
    }

    let pathname = normalizePath(url.pathname)

    // Gas API should never be used in Offline-Core (RPC-only gas pricing).
    if (url.hostname === 'api.curve.finance' && pathname.startsWith('/api/getGas')) {
      event.respondWith(jsonError(503, 'offline-core-disabled', 'Gas API disabled in Offline-Core'))
      return
    }

    if (url.search) {
      const mapped = mapQueryUrl(url)
      if (mapped.error) {
        event.respondWith(jsonError(404, 'offline-core-unsupported-query', url.pathname + url.search))
        return
      }
      pathname = mapped.pathname
    }

    const rewrittenUrl = joinStaticUrl(STATIC_DATA_BASE_URL, url.hostname, pathname)
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME)
        const cached = await cache.match(rewrittenUrl)
        if (cached) {
          const cachedStub = await maybeStubAndCache(cache, rewrittenUrl, url.hostname, pathname, cached)
          const toReturn = cachedStub || cached

          event.waitUntil(
            fetch(rewrittenUrl, { cache: 'no-store' })
              .then((resp) => {
                if (resp && resp.ok && !isHtmlResponse(resp)) return cache.put(rewrittenUrl, resp.clone())
              })
              .catch(() => {}),
          )
          return toReturn
        }
        const resp = await cacheFirst(rewrittenUrl)
        return (await maybeStubAndCache(cache, rewrittenUrl, url.hostname, pathname, resp)) || resp
      })(),
    )
    return
  }

  // Default: passthrough.
  return
})
