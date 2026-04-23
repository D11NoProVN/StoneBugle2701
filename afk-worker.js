const bedrock = require('bedrock-protocol')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { BedrockTaskHelper, createLogger, getAuthCacheDir, inspect, stripMcColorCodes } = require('./main')

function buildRandomAreaPool(min = 10, max = 70) {
  const values = []
  for (let area = min; area <= max; area += 1) values.push(area)
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = values[i]
    values[i] = values[j]
    values[j] = tmp
  }
  return values
}

const DEFAULT_AREAS = buildRandomAreaPool()
const AFK_COMMAND_DELAY_MS = 5000
const AFK_AUTO_ASSIGN_GRACE_MS = 6500
const AFK_RESULT_TIMEOUT_MS = 8000
const HEARTBEAT_MS = 30000
const RECONNECT_DELAY_MS = 10000
const RECONNECT_WATCHDOG_MS = 20000
const ALREADY_LOGGED_IN_RECONNECT_DELAY_MS = 3000
const ALREADY_LOGGED_IN_MAX_RETRIES = 3
const AFK_ANTI_IDLE_MS = 45000
const AFK_ANCHOR_CAPTURE_DELAY_MS = 2000
const AFK_DRIFT_CHECK_MS = 15000
const AFK_DRIFT_DISTANCE = 24
const AFK_REJOIN_COOLDOWN_MS = 12000
const DASHBOARD_REFRESH_MS = 60000
const DASHBOARD_HOST = process.env.AFK_WEB_HOST || '127.0.0.1'
const DASHBOARD_PORT = Number(process.env.AFK_WEB_PORT || 3020)
const DASHBOARD_LOG_LIMIT = 240
function parseAreaList(raw) {
  if (!raw) return DEFAULT_AREAS
  return raw
    .split(',')
    .map(value => Number(String(value).trim()))
    .filter(value => Number.isInteger(value) && value > 0)
}

function normalizeChat(message) {
  return stripMcColorCodes(String(message || ''))
    .replace(/[ᴀᴬⓐ🄰Ａ]/g, 'a')
    .replace(/[ꜰғᶠⓕ🄵Ｆ]/g, 'f')
    .replace(/[ᴋᵏⓚ🄺Ｋ]/g, 'k')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function parseFormattedNumber(text) {
  const clean = stripMcColorCodes(String(text || '')).trim()
  const match = clean.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/i)
  if (!match) return null
  const value = parseFloat(match[1])
  const suffix = String(match[2] || '').toLowerCase()
  const multiplier = suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : suffix === 'b' ? 1e9 : 1
  return Math.floor(value * multiplier)
}

function cleanScoreboardText(text) {
  return stripMcColorCodes(String(text || ''))
    .replace(/§./g, ' ')
    .replace(/§+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractShardScore(entries = []) {
  for (const scoreEntry of entries) {
    const raw = scoreEntry.custom_name || scoreEntry.objective_name || ''
    const clean = cleanScoreboardText(raw)
    const normalized = normalizeChat(clean)
    if (!normalized.includes('shard') && !normalized.includes('balance')) continue
    return {
      raw: clean,
      value: parseFormattedNumber(clean)
    }
  }
  return null
}

function extractScoreboardStat(entries = [], { keywords = [], valuePattern = null, parser = null } = {}) {
  for (const scoreEntry of entries) {
    const raw = scoreEntry.custom_name || scoreEntry.objective_name || ''
    const clean = cleanScoreboardText(raw)
    const normalized = normalizeChat(clean)
    if (!keywords.every(keyword => normalized.includes(keyword))) continue

    let value = null
    if (typeof parser === 'function') {
      value = parser(clean)
    } else if (valuePattern) {
      const match = clean.match(valuePattern)
      value = match ? match[1].trim() : null
    } else {
      value = clean
    }

    return {
      raw: clean,
      value
    }
  }
  return null
}

function buildAfkAnalyzer(targetArea) {
  return function analyzeAfkMessage(message) {
    const text = normalizeChat(message)
    const areaText = String(targetArea)
    const hasAreaNumber = text.includes(areaText)

    const fullPatterns = [
      'full',
      'is full',
      'server full',
      'afk full'
    ]

    const successPatterns = [
      'already in afk',
      'already afk',
      'joined afk',
      'sent to afk',
      'teleported to afk',
      'now in afk',
      'already in area',
      'you are already in'
    ]

    const genericFailurePatterns = [
      'invalid',
      'unknown area',
      'does not exist',
      'cooldown',
      'wait',
      'permission',
      'cannot',
      'not available'
    ]

    if (fullPatterns.some(pattern => text.includes(pattern))) {
      return { type: 'full', area: targetArea, text }
    }

    if (
      hasAreaNumber &&
      (
        text.includes('you are already in') ||
        text.includes('already in') ||
        text.includes('teleported to')
      )
    ) {
      return { type: 'success', area: targetArea, text }
    }

    if (
      successPatterns.some(pattern => text.includes(pattern)) &&
      (!/\b\d+\b/.test(text) || hasAreaNumber)
    ) {
      return { type: 'success', area: targetArea, text }
    }

    if (hasAreaNumber && text.includes('afk') && !fullPatterns.some(pattern => text.includes(pattern))) {
      if (
        text.includes('joined') ||
        text.includes('teleported') ||
        text.includes('entered') ||
        text.includes('already')
      ) {
        return { type: 'success', area: targetArea, text }
      }
    }

    if (genericFailurePatterns.some(pattern => text.includes(pattern))) {
      return { type: 'failure', area: targetArea, text }
    }

    return null
  }
}

const logger = createLogger()
const dashboardClients = new Set()
const dashboardLogBuffer = []
let dashboardBroadcastTimeout = null
let dashboardServerStarted = false

// --- Cloud Bridge: gửi log/state về webhook manager khi chạy trên GitHub Actions ---
const CLOUD_MODE = process.env.CLOUD_MODE === 'true'
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || ''
const CLOUD_FLUSH_MS = 2000
const cloudQueue = []
let cloudFlushTimer = null
let cloudFlushing = false

function cloudEnqueue(type, data) {
  if (!CLOUD_MODE || !WEBHOOK_URL) return
  cloudQueue.push({ type, data, ts: Date.now() })
  if (cloudQueue.length > 500) cloudQueue.splice(0, cloudQueue.length - 500) // cap
  scheduleCloudFlush()
}

function scheduleCloudFlush() {
  if (cloudFlushTimer || cloudFlushing) return
  cloudFlushTimer = setTimeout(flushCloudQueue, CLOUD_FLUSH_MS)
}

async function fetchPublicIpv4(timeoutMs = 8000) {
  // Thử nhiều endpoint, dùng HTTPS, IPv4 only (family: 4)
  const endpoints = [
    'https://api.ipify.org?format=text',
    'https://ifconfig.me/ip',
    'https://ipv4.icanhazip.com'
  ]
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint)
      const lib = url.protocol === 'https:' ? require('https') : require('http')
      const ip = await new Promise((resolve, reject) => {
        const req = lib.request(endpoint, { method: 'GET', family: 4, timeout: timeoutMs }, res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.on('timeout', () => { try { req.destroy() } catch {}; reject(new Error('timeout')) })
        req.end()
      })
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip
    } catch {}
  }
  return null
}

async function reportIpAndCheck() {
  if (!CLOUD_MODE || !WEBHOOK_URL) return { allowed: true, skipped: true }

  const ipv4 = await fetchPublicIpv4()
  if (!ipv4) {
    log('[CLOUD] [IP_LOOKUP_FAILED] — skip IP check, cho phép chạy')
    return { allowed: true, skipped: true }
  }

  log(`[CLOUD] [IP:${ipv4}]`)

  try {
    const url = new URL(WEBHOOK_URL)
    const lib = url.protocol === 'https:' ? require('https') : require('http')
    const body = JSON.stringify({
      accountId: process.env.ACCOUNT_ID || 'unknown',
      runId: process.env.GITHUB_RUN_ID || null,
      events: [{ type: 'ip_report', data: { ipv4 }, ts: Date.now() }]
    })
    const response = await new Promise((resolve, reject) => {
      const req = lib.request(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Webhook-Token': WEBHOOK_TOKEN
        },
        timeout: 10000
      }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
          catch { resolve({}) }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { try { req.destroy() } catch {}; reject(new Error('timeout')) })
      req.write(body)
      req.end()
    })

    if (response?.ipCheck) {
      return { ...response.ipCheck, ipv4 }
    }
    // Nếu manager không trả về ipCheck (có thể version cũ), mặc định cho chạy
    return { allowed: true, ipv4 }
  } catch (err) {
    log(`[CLOUD] [IP_CHECK_FAILED] [REASON:${err.message}] — cho phép chạy để tránh kẹt`)
    return { allowed: true, ipv4, error: err.message }
  }
}

async function flushCloudQueue() {
  cloudFlushTimer = null
  if (cloudFlushing) return
  if (cloudQueue.length === 0) return
  cloudFlushing = true

  const batch = cloudQueue.splice(0, cloudQueue.length)
  try {
    const url = new URL(WEBHOOK_URL)
    const lib = url.protocol === 'https:' ? require('https') : require('http')
    const body = JSON.stringify({
      accountId: process.env.ACCOUNT_ID || 'unknown',
      runId: process.env.GITHUB_RUN_ID || null,
      events: batch
    })
    await new Promise((resolve) => {
      const req = lib.request(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Webhook-Token': WEBHOOK_TOKEN
        },
        timeout: 8000
      }, res => {
        res.resume()
        res.on('end', resolve)
        res.on('error', resolve)
      })
      req.on('error', () => resolve())
      req.on('timeout', () => { try { req.destroy() } catch {}; resolve() })
      req.write(body)
      req.end()
    })
  } catch {
    // nuốt lỗi, không crash bot
  } finally {
    cloudFlushing = false
    if (cloudQueue.length > 0) scheduleCloudFlush()
  }
}
let dashboardServer = null

function appendDashboardLog(message) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
  dashboardLogBuffer.push(`${time} ${message}`)
  if (dashboardLogBuffer.length > DASHBOARD_LOG_LIMIT) {
    dashboardLogBuffer.splice(0, dashboardLogBuffer.length - DASHBOARD_LOG_LIMIT)
  }
}

function log(message) {
  const line = String(message)
  appendDashboardLog(line)
  if (process.env.IS_WORKER === 'true' && process.send) {
    process.send({ type: 'log', data: line })
  }
  cloudEnqueue('log', line)
  logger.log(line)
  scheduleDashboardBroadcast()
}

const areas = parseAreaList(process.env.AFK_AREAS)
const accountId = process.env.ACCOUNT_ID || 'default-account'
const authCacheDir = getAuthCacheDir(path.join('.auth-cache', accountId))

const state = {
  client: null,
  spawned: false,
  afkAttemptInFlight: false,
  afkSuccess: false,
  currentAreaIndex: 0,
  currentTargetArea: null,
  currentTimeout: null,
  anchorTimeout: null,
  reconnectTimeout: null,
  reconnectWatchdogTimeout: null,
  reconnecting: false,
  reconnectAttempt: 0,
  alreadyLoggedInRetries: 0,
  shuttingDown: false,
  waitingForAutoAssign: false,
  spawnCommandTimeout: null,
  lastStatusAt: null,
  successAt: null,
  lastKnownAreaFromChat: null,
  currentPosition: null,
  afkAnchorPosition: null,
  afkAnchorCapturedAt: null,
  lastRejoinAt: null,
  lastActivityAt: null,
  scoreboardEntryMap: new Map(),
  scoreboardObjectiveMap: new Map(),
  scoreboardEntries: [],
  scoreboardObjectives: [],
  lastShardValue: null,
  lastShardRaw: null,
  accountUsername: null,
  accountXuid: null
}

const helper = new BedrockTaskHelper({
  log,
  snapshotFile: 'afk_snapshot.json'
})

// --- Local playtime tracker ---
// Tự đếm playtime cộng dồn qua các session, persist ra file để không mất khi restart.
// Hữu ích khi server không update scoreboard playtime trong lúc bot AFK.
const playtimeDataDir = path.join(__dirname, 'data', 'playtime')
try { fs.mkdirSync(playtimeDataDir, { recursive: true }) } catch {}
const playtimeFile = path.join(playtimeDataDir, `${accountId}.json`)

function loadPersistedPlaytime() {
  try {
    const data = JSON.parse(fs.readFileSync(playtimeFile, 'utf8'))
    return Number(data.totalSeconds) || 0
  } catch { return 0 }
}

function savePersistedPlaytime() {
  try {
    fs.writeFileSync(playtimeFile, JSON.stringify({
      accountId,
      username: state.accountUsername,
      totalSeconds: state.localPlaytimeTotalSeconds,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8')
  } catch (err) {
    log(`[PLAYTIME] [SAVE_FAIL] [REASON:${compactReason(err.message, 28)}]`)
  }
}

state.localPlaytimeTotalSeconds = loadPersistedPlaytime()
state.localPlaytimeSessionStart = null // timestamp (ms) khi spawn session hiện tại

function startLocalPlaytimeSession() {
  if (state.localPlaytimeSessionStart != null) return
  state.localPlaytimeSessionStart = Date.now()
}

function stopLocalPlaytimeSession() {
  if (state.localPlaytimeSessionStart == null) return
  const elapsed = Math.max(0, Math.floor((Date.now() - state.localPlaytimeSessionStart) / 1000))
  state.localPlaytimeTotalSeconds += elapsed
  state.localPlaytimeSessionStart = null
  savePersistedPlaytime()
}

function getLocalPlaytimeSeconds() {
  const base = state.localPlaytimeTotalSeconds || 0
  if (state.localPlaytimeSessionStart == null) return base
  const elapsed = Math.max(0, Math.floor((Date.now() - state.localPlaytimeSessionStart) / 1000))
  return base + elapsed
}

function formatDurationHuman(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) return '0s'
  const d = Math.floor(totalSeconds / 86400)
  const h = Math.floor((totalSeconds % 86400) / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0 && d === 0) parts.push(`${m}m`)
  if (s > 0 && d === 0 && h === 0) parts.push(`${s}s`)
  return parts.join(' ') || '0s'
}

// Tick + auto-save mỗi 30s khi đang spawn
setInterval(() => {
  if (state.spawned && state.localPlaytimeSessionStart != null) {
    // Commit incremental để không mất nếu worker crash
    const elapsed = Math.max(0, Math.floor((Date.now() - state.localPlaytimeSessionStart) / 1000))
    if (elapsed > 0) {
      state.localPlaytimeTotalSeconds += elapsed
      state.localPlaytimeSessionStart = Date.now()
      savePersistedPlaytime()
    }
  }
}, 30000)

log('--- Starting afk.js ---')
log('[AFK] [AREA_POOL] [RANDOM:10-70]')
log(`[PLAYTIME] [LOADED:${formatDurationHuman(state.localPlaytimeTotalSeconds)}] [TOTAL_SEC:${state.localPlaytimeTotalSeconds}]`)

process.on('uncaughtException', err => {
  log(`[UNCAUGHT] [REASON:${compactReason(err?.message || err, 40)}]`)
  log(`[DETAIL] ${inspect(err)}`)
  if (!state.shuttingDown) {
    try { state.client?.close() } catch {}
    state.client = null
    scheduleReconnect(`uncaught:${err?.message || err}`)
  }
})

process.on('unhandledRejection', reason => {
  log(`[UNHANDLED_REJECTION] [REASON:${compactReason(String(reason?.message || reason), 40)}]`)
})

function clearAfkTimeout() {
  if (state.currentTimeout) {
    clearTimeout(state.currentTimeout)
    state.currentTimeout = null
  }
}

function clearSpawnCommandTimeout() {
  if (state.spawnCommandTimeout) {
    clearTimeout(state.spawnCommandTimeout)
    state.spawnCommandTimeout = null
  }
}

function clearAnchorTimeout() {
  if (state.anchorTimeout) {
    clearTimeout(state.anchorTimeout)
    state.anchorTimeout = null
  }
}

function clearReconnectTimeout() {
  if (state.reconnectTimeout) {
    clearTimeout(state.reconnectTimeout)
    state.reconnectTimeout = null
  }
}

function clearReconnectWatchdogTimeout() {
  if (state.reconnectWatchdogTimeout) {
    clearTimeout(state.reconnectWatchdogTimeout)
    state.reconnectWatchdogTimeout = null
  }
}

function resetJoinState({ keepSuccess = false } = {}) {
  clearAfkTimeout()
  clearSpawnCommandTimeout()
  clearAnchorTimeout()
  clearReconnectWatchdogTimeout()
  stopLocalPlaytimeSession()
  state.spawned = false
  state.afkAttemptInFlight = false
  state.waitingForAutoAssign = false
  if (!keepSuccess) state.afkSuccess = false
  state.lastKnownAreaFromChat = null
  state.currentPosition = null
  state.afkAnchorPosition = null
  state.afkAnchorCapturedAt = null
  state.lastActivityAt = null
  state.scoreboardEntryMap = new Map()
  state.scoreboardObjectiveMap = new Map()
  state.scoreboardEntries = []
  state.scoreboardObjectives = []
  state.lastShardValue = null
  state.lastShardRaw = null
  state.accountUsername = null
  state.accountXuid = null
  helper.initializedSent = false
  helper.currentContainer = null
  scheduleDashboardBroadcast()
}

function clonePosition(position) {
  if (!position) return null
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
}

function formatPosition(position) {
  if (!position) return 'unknown'
  return `${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`
}

function compactReason(reason, maxLength = 48) {
  const text = String(reason || 'unknown')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text
}

function clampDisplayText(value, fallback = 'UNKNOWN') {
  const text = String(value || '').trim()
  return text || fallback
}

function getDashboardConnectionState() {
  if (state.reconnecting) return 'RECONNECTING'
  if (state.spawned && state.afkSuccess) return 'AFK_LOCKED'
  if (state.spawned) return 'ONLINE'
  if (state.client) return 'CONNECTING'
  return 'OFFLINE'
}

function isAlreadyLoggedInReason(reason) {
  const text = normalizeChat(reason)
  return text.includes('already logged in') || text.includes('already online')
}

function getScoreboardObjectiveKey(objective) {
  return `${objective.display_slot || 'unknown'}:${objective.objective_name || 'unknown'}`
}

function getScoreboardEntryKey(scoreEntry, index = 0) {
  const uniqueId = scoreEntry.scoreboard_id
    ?? scoreEntry.entry_unique_id
    ?? scoreEntry.entity_unique_id
    ?? scoreEntry.runtime_entity_id
    ?? scoreEntry.player_unique_id
  if (uniqueId != null) return `id:${String(uniqueId)}`

  const objective = scoreEntry.objective_name || 'unknown'
  const score = scoreEntry.score ?? 'unknown'
  const type = scoreEntry.type || 'unknown'
  return `fallback:${objective}:${score}:${type}:${index}`
}

function syncScoreboardSnapshots() {
  state.scoreboardObjectives = Array.from(state.scoreboardObjectiveMap.values())
  state.scoreboardEntries = Array.from(state.scoreboardEntryMap.values())
    .sort((a, b) => {
      const scoreA = Number.isFinite(Number(a.score)) ? Number(a.score) : -Infinity
      const scoreB = Number.isFinite(Number(b.score)) ? Number(b.score) : -Infinity
      if (scoreA !== scoreB) return scoreB - scoreA
      return String(a.custom_name || a.objective_name || '').localeCompare(String(b.custom_name || b.objective_name || ''))
    })
  scheduleDashboardBroadcast()
}

function updateScoreboardObjective(params) {
  if (!params) return
  state.scoreboardObjectiveMap.set(getScoreboardObjectiveKey(params), { ...params })
  syncScoreboardSnapshots()
}

let scoreboardDebugDumped = false
function updateScoreboardEntries(params) {
  const action = String(params?.action || 'change').toLowerCase()
  const entries = Array.isArray(params?.entries) ? params.entries : []
  if (entries.length === 0) return

  // DEBUG: dump scoreboard 1 lần để hỗ trợ chẩn đoán money/shards = 0
  if (!scoreboardDebugDumped && action !== 'remove') {
    scoreboardDebugDumped = true
    try {
      const lines = entries.slice(0, 20).map((e, i) => {
        const raw = e.custom_name || e.objective_name || ''
        const clean = cleanScoreboardText(raw)
        return `  #${i} score=${e.score} obj="${e.objective_name || ''}" name="${clean}"`
      })
      log(`[SCOREBOARD_DUMP] [ENTRIES:${entries.length}] [ACTION:${action}]\n${lines.join('\n')}`)
    } catch (err) {
      log(`[SCOREBOARD_DUMP] [ERR:${err.message}]`)
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const scoreEntry = entries[index]
    const key = getScoreboardEntryKey(scoreEntry, index)
    if (action === 'remove') {
      state.scoreboardEntryMap.delete(key)
      continue
    }
    state.scoreboardEntryMap.set(key, { ...scoreEntry })
  }

  syncScoreboardSnapshots()
}

function refreshShardState() {
  const shard = extractShardScore(state.scoreboardEntries)
  state.lastShardValue = shard?.value ?? null
  state.lastShardRaw = shard?.raw ?? null
  return shard
}

function printShardScore() {
  const shard = refreshShardState()
  if (!shard) {
    log('[SCOREBOARD] [SHARD] [NOT_FOUND]')
    return
  }

  const value = shard.value == null ? 'UNKNOWN' : shard.value
  log(`[SCOREBOARD] [SHARD] [VALUE:${value}] [RAW:${shard.raw}]`)
}

function printNumericScoreboardStat(label, keywords) {
  const stat = extractScoreboardStat(state.scoreboardEntries, {
    keywords,
    parser: raw => parseFormattedNumber(raw)
  })

  if (!stat) {
    log(`[SCOREBOARD] [${label}] [NOT_FOUND]`)
    return
  }

  const value = stat.value == null ? 'UNKNOWN' : stat.value
  log(`[SCOREBOARD] [${label}] [VALUE:${value}] [RAW:${stat.raw}]`)
}

// Parse playtime string to total seconds. Supports "2h 5m 30s", "1d 2h", "125m", "3600s", "02:45:10"...
function parsePlaytimeToSeconds(raw) {
  if (!raw) return null
  const text = String(raw).toLowerCase().trim()
  // HH:MM:SS or MM:SS
  const colonMatch = text.match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/)
  if (colonMatch) {
    const a = Number(colonMatch[1])
    const b = Number(colonMatch[2])
    const c = colonMatch[3] != null ? Number(colonMatch[3]) : null
    return c != null ? a * 3600 + b * 60 + c : a * 60 + b
  }
  // Token units: 2d 3h 5m 30s
  let seconds = 0
  let matched = false
  const units = [
    [/(\d+)\s*d(?:ays?)?/i, 86400],
    [/(\d+)\s*h(?:ours?|rs?)?/i, 3600],
    [/(\d+)\s*m(?:in(?:utes?)?)?/i, 60],
    [/(\d+)\s*s(?:ec(?:onds?)?)?/i, 1]
  ]
  for (const [re, mult] of units) {
    const m = text.match(re)
    if (m) {
      matched = true
      seconds += Number(m[1]) * mult
    }
  }
  return matched ? seconds : null
}

function extractPlaytimeStat() {
  // Flexible: match entries có chứa 'playtime' bằng normalizeChat, extract giá trị bằng cách bỏ phần 'playtime' ra.
  for (const scoreEntry of state.scoreboardEntries) {
    const raw = scoreEntry.custom_name || scoreEntry.objective_name || ''
    const clean = cleanScoreboardText(raw)
    const normalized = normalizeChat(clean)
    if (!normalized.includes('playtime')) continue

    // Bỏ chữ "playtime" và các dấu phân cách phổ biến (:, -, ·, |, .) rồi trim
    let value = clean.replace(/playtime/i, '').replace(/^[\s:·•\-|.,>=]+|[\s:·•\-|.,>=]+$/g, '').trim()
    // Nếu value rỗng, thử lấy score
    if (!value && scoreEntry.score != null) {
      value = String(scoreEntry.score)
    }
    const seconds = parsePlaytimeToSeconds(value)
    return { raw: clean, value: value || null, seconds }
  }
  return null
}

function printPlaytimeScore() {
  const stat = extractPlaytimeStat()
  if (!stat) {
    log('[SCOREBOARD] [PLAYTIME] [NOT_FOUND]')
    return
  }
  log(`[SCOREBOARD] [PLAYTIME] [VALUE:${stat.value || 'UNKNOWN'}] [SEC:${stat.seconds ?? 'UNKNOWN'}] [RAW:${stat.raw}]`)
}

function getScoreboardStats() {
  const shard = refreshShardState()
  const money = extractScoreboardStat(state.scoreboardEntries, {
    keywords: ['money'],
    parser: raw => parseFormattedNumber(raw)
  })
  const kills = extractScoreboardStat(state.scoreboardEntries, {
    keywords: ['kills'],
    parser: raw => parseFormattedNumber(raw)
  })
  const deaths = extractScoreboardStat(state.scoreboardEntries, {
    keywords: ['deaths'],
    parser: raw => parseFormattedNumber(raw)
  })
  const playtime = extractPlaytimeStat()
  const localSeconds = getLocalPlaytimeSeconds()

  // Ưu tiên server value (nếu parse được seconds), fallback sang local
  const displaySeconds = (playtime?.seconds != null && playtime.seconds > 0)
    ? playtime.seconds
    : localSeconds
  const displayValue = playtime?.value || formatDurationHuman(localSeconds)

  return {
    money: {
      value: money?.value ?? null,
      raw: money?.raw ?? null
    },
    shards: {
      value: shard?.value ?? null,
      raw: shard?.raw ?? null
    },
    kills: {
      value: kills?.value ?? null,
      raw: kills?.raw ?? null
    },
    deaths: {
      value: deaths?.value ?? null,
      raw: deaths?.raw ?? null
    },
    playtime: {
      value: displayValue,
      raw: playtime?.raw ?? null,
      seconds: displaySeconds,
      serverSeconds: playtime?.seconds ?? null,
      localSeconds,
      source: (playtime?.seconds != null && playtime.seconds > 0) ? 'server' : 'local'
    }
  }
}

function getDashboardSnapshot() {
  return {
    account: {
      username: state.accountUsername,
      xuid: state.accountXuid
    },
    connection: {
      state: getDashboardConnectionState(),
      reconnecting: state.reconnecting,
      reconnectAttempt: state.reconnectAttempt,
      spawned: state.spawned,
      hasClient: Boolean(state.client)
    },
    afk: {
      success: state.afkSuccess,
      currentArea: state.currentTargetArea,
      waitingForAutoAssign: state.waitingForAutoAssign,
      attemptInFlight: state.afkAttemptInFlight,
      currentPosition: state.currentPosition ? formatPosition(state.currentPosition) : null,
      anchorPosition: state.afkAnchorPosition ? formatPosition(state.afkAnchorPosition) : null,
      lastActivityAt: state.lastActivityAt,
      lastStatusAt: state.lastStatusAt
    },
    scoreboard: getScoreboardStats(),
    objectives: state.scoreboardObjectives.map(objective => ({
      name: objective.objective_name || 'UNKNOWN',
      display: stripMcColorCodes(objective.display_name || objective.objective_name || ''),
      slot: objective.display_slot || 'UNKNOWN'
    })),
    logLines: dashboardLogBuffer.slice(-120)
  }
}

function broadcastDashboard(event, payload) {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const client of Array.from(dashboardClients)) {
    try {
      client.write(body)
    } catch {
      dashboardClients.delete(client)
    }
  }
}

function scheduleDashboardBroadcast() {
  if (dashboardBroadcastTimeout) return
  dashboardBroadcastTimeout = setTimeout(() => {
    dashboardBroadcastTimeout = null
    const snapshot = getDashboardSnapshot()
    if (process.env.IS_WORKER === 'true' && process.send) {
      process.send({ type: 'state', data: snapshot })
    }
    cloudEnqueue('state', snapshot)
    if (dashboardClients.size === 0) return
    broadcastDashboard('state', snapshot)
  }, 120)
}

function serveDashboardAsset(filePath, contentType, response) {
  try {
    const body = fs.readFileSync(filePath)
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    })
    response.end(body)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  }
}

function startDashboardServer() {
  if (dashboardServerStarted) return
  dashboardServerStarted = true

  const webRoot = path.join(__dirname, 'ui')
  const server = http.createServer((request, response) => {
    const url = request.url || '/'
    if (url === '/' || url === '/index.html') {
      serveDashboardAsset(path.join(webRoot, 'index.html'), 'text/html; charset=utf-8', response)
      return
    }

    if (url === '/app.css') {
      serveDashboardAsset(path.join(webRoot, 'app.css'), 'text/css; charset=utf-8', response)
      return
    }

    if (url === '/app.js') {
      serveDashboardAsset(path.join(webRoot, 'app.js'), 'application/javascript; charset=utf-8', response)
      return
    }

    if (url === '/api/state') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(JSON.stringify(getDashboardSnapshot()))
      return
    }

    if (url === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      response.write('\n')
      dashboardClients.add(response)
      response.write(`event: state\ndata: ${JSON.stringify(getDashboardSnapshot())}\n\n`)
      const heartbeat = setInterval(() => {
        try {
          response.write('event: ping\ndata: {}\n\n')
        } catch {}
      }, 15000)
      request.on('close', () => {
        clearInterval(heartbeat)
        dashboardClients.delete(response)
      })
      return
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })

  dashboardServer = server

  server.on('error', err => {
    logger.log(`[WEB] [ERROR] [REASON:${compactReason(err?.message || err, 40)}]`)
  })

  server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    log(`[WEB] [LIVE] [URL:http://${DASHBOARD_HOST}:${DASHBOARD_PORT}]`)
  })
}

function printFullScoreboard() {
  const objectives = state.scoreboardObjectives || []
  const entries = state.scoreboardEntries || []

  if (objectives.length === 0 && entries.length === 0) {
    log('[SCOREBOARD] [FULL] [EMPTY]')
    return
  }

  log(`[SCOREBOARD] [FULL] [OBJECTIVES:${objectives.length}] [ENTRIES:${entries.length}]`)

  for (const objective of objectives) {
    const display = cleanScoreboardText(objective.display_name || objective.objective_name || '')
    log(`[SCOREBOARD] [OBJECTIVE] [NAME:${objective.objective_name || 'UNKNOWN'}] [DISPLAY:${display || 'NONE'}] [SLOT:${objective.display_slot || 'UNKNOWN'}]`)
  }

  for (const scoreEntry of entries) {
    const raw = cleanScoreboardText(scoreEntry.custom_name || scoreEntry.objective_name || '')
    const score = scoreEntry.score ?? 'UNKNOWN'
    const objective = scoreEntry.objective_name || 'UNKNOWN'
    const type = scoreEntry.type || 'UNKNOWN'
    log(`[SCOREBOARD] [ENTRY] [OBJECTIVE:${objective}] [TYPE:${type}] [SCORE:${score}] [RAW:${raw || 'NONE'}]`)
  }
}

function captureAccountIdentity(client) {
  const accountUsername = client?.profile?.name || client?.username || null
  const accountXuid = client?.profile?.xuid ?? null
  if (!accountUsername && accountXuid == null) return
  if (state.accountUsername === accountUsername && state.accountXuid === accountXuid) return

  state.accountUsername = accountUsername
  state.accountXuid = accountXuid
  log(`[ACCOUNT] [USER:${accountUsername || 'UNKNOWN'}] [XUID:${accountXuid ?? 'UNKNOWN'}]`)
}

function handleConsoleCommand(input) {
  const command = String(input || '').trim().toLowerCase()
  if (!command) return

  if (command === '/shard') {
    printShardScore()
    return
  }

  if (command === '/money') {
    printNumericScoreboardStat('MONEY', ['money'])
    return
  }

  if (command === '/kills') {
    printNumericScoreboardStat('KILLS', ['kills'])
    return
  }

  if (command === '/deaths') {
    printNumericScoreboardStat('DEATHS', ['deaths'])
    return
  }

  if (command === '/playtime') {
    printPlaytimeScore()
    return
  }

  if (command === '/sb') {
    printFullScoreboard()
    return
  }

  log(`[CONSOLE] [UNKNOWN] ${command}`)
}

function positionDistance(a, b) {
  if (!a || !b) return Infinity
  const dx = Number(a.x) - Number(b.x)
  const dy = Number(a.y) - Number(b.y)
  const dz = Number(a.z) - Number(b.z)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function captureAfkAnchor(reason) {
  if (!state.currentPosition || !state.afkSuccess) return
  state.afkAnchorPosition = clonePosition(state.currentPosition)
  state.afkAnchorCapturedAt = new Date().toISOString()
  log(`[AFK] Anchor captured (${reason}) at ${formatPosition(state.afkAnchorPosition)}`)
  helper.saveSnapshot('afk_anchor_captured', {
    afk_state: {
      area: state.currentTargetArea,
      success: state.afkSuccess,
      anchor_position: state.afkAnchorPosition,
      anchor_reason: reason,
      anchor_captured_at: state.afkAnchorCapturedAt
    }
  })
}

function scheduleAnchorCapture(reason) {
  clearAnchorTimeout()
  state.anchorTimeout = setTimeout(() => {
    state.anchorTimeout = null
    captureAfkAnchor(reason)
  }, AFK_ANCHOR_CAPTURE_DELAY_MS)
}

function updateCurrentPosition(position, source = 'unknown') {
  if (!position) return
  state.currentPosition = clonePosition(position)
  scheduleDashboardBroadcast()

  if (state.afkSuccess && !state.afkAnchorPosition) {
    scheduleAnchorCapture(`first_position_after_success:${source}`)
  }
}

function canTriggerRejoinNow() {
  if (state.afkAttemptInFlight || state.reconnecting || state.shuttingDown) return false
  if (!state.lastRejoinAt) return true
  return Date.now() - state.lastRejoinAt >= AFK_REJOIN_COOLDOWN_MS
}

function markAfkSuccess(reason) {
  clearAfkTimeout()
  state.afkAttemptInFlight = false
  state.afkSuccess = true
  state.successAt = new Date().toISOString()
  state.lastStatusAt = state.successAt
  log(`[AFK] [SUCCESS] [AFK:${state.currentTargetArea}] [REASON:${compactReason(reason, 36)}]`)
  scheduleAnchorCapture('afk_success')
  helper.saveSnapshot('afk_success', {
    afk_state: {
      area: state.currentTargetArea,
      reason,
      success_at: state.successAt
    }
  })
}

function scheduleRejoin(reason, { immediate = false, allowAreaAdvance = false } = {}) {
  if (allowAreaAdvance) {
    state.afkSuccess = false
    moveToNextArea(reason)
    return
  }

  clearAfkTimeout()
  state.afkSuccess = false
  state.afkAttemptInFlight = false
  state.lastStatusAt = new Date().toISOString()
  state.lastRejoinAt = Date.now()
  log(`[AFK] [REJOIN] [REASON:${compactReason(reason)}]`)
  setTimeout(tryJoinCurrentArea, immediate ? 500 : 2500)
}

function moveToNextArea(reason) {
  clearAfkTimeout()
  state.afkAttemptInFlight = false
  state.afkSuccess = false
  state.currentAreaIndex += 1

  if (state.currentAreaIndex >= areas.length) {
    log(`[AFK] [EXHAUSTED] [REASON:${compactReason(reason)}]`)
    helper.saveSnapshot('afk_exhausted', {
      afk_state: {
        exhausted: true,
        reason
      }
    })
    return
  }

  log(`[AFK] [NEXT_AREA] [REASON:${compactReason(reason)}]`)
  setTimeout(tryJoinCurrentArea, 1500)
}

function tryJoinCurrentArea() {
  if (state.afkSuccess || state.afkAttemptInFlight) return
  if (state.currentAreaIndex >= areas.length) return

  state.currentTargetArea = areas[state.currentAreaIndex]
  state.afkAttemptInFlight = true
  state.lastStatusAt = new Date().toISOString()

  const command = `/afk ${state.currentTargetArea}`
  log(`[AFK] [TRY] [AFK:${state.currentTargetArea}]`)

  try {
    helper.sendCommand(command)
  } catch (err) {
    state.afkAttemptInFlight = false
    log(`[AFK] [COMMAND_FAIL] [AFK:${state.currentTargetArea}] [REASON:${compactReason(err.message)}]`)
    setTimeout(tryJoinCurrentArea, 3000)
    return
  }

  state.currentTimeout = setTimeout(() => {
    if (state.afkSuccess || !state.afkAttemptInFlight) return
    log(`[AFK] [TIMEOUT] [AFK:${state.currentTargetArea}] [WAIT:${AFK_RESULT_TIMEOUT_MS}ms]`)
    state.afkAttemptInFlight = false
    helper.saveSnapshot('afk_timeout', {
      afk_state: {
        area: state.currentTargetArea,
        timeout_ms: AFK_RESULT_TIMEOUT_MS
      }
    })
    setTimeout(tryJoinCurrentArea, 5000)
  }, AFK_RESULT_TIMEOUT_MS)
}

function parseTeleportedArea(message) {
  const cleaned = stripMcColorCodes(String(message || ''))
  const match = cleaned.match(/teleported to .*?(\d+)\.?$/i)
  if (!match) return null
  return Number(match[1])
}

function detectAutoAssignedAfkArea(cleanMessage) {
  const text = normalizeChat(cleanMessage)
  const area = parseTeleportedArea(cleanMessage)
  if (area == null) return null
  if (!text.includes('teleported to')) return null
  if (!text.includes('afk')) return null
  return area
}

function markAutoAssignedAfk(area, reason) {
  clearSpawnCommandTimeout()
  state.waitingForAutoAssign = false
  state.currentTargetArea = area
  state.lastKnownAreaFromChat = area

  const existingIndex = areas.indexOf(area)
  if (existingIndex >= 0) state.currentAreaIndex = existingIndex

  markAfkSuccess(reason)
}

function handlePostSuccessChat(cleanMessage) {
  const text = normalizeChat(cleanMessage)
  const teleportedArea = parseTeleportedArea(cleanMessage)

  if (teleportedArea != null) {
    state.lastKnownAreaFromChat = teleportedArea
    if (state.currentTargetArea != null && teleportedArea !== state.currentTargetArea) {
      if (canTriggerRejoinNow()) {
        scheduleRejoin(`moved out of afk area ${state.currentTargetArea} to area ${teleportedArea}`, { immediate: true })
      }
      return
    }
  }

  const maintenancePatterns = [
    'maintenance',
    'disabled',
    'temporarily unavailable',
    'đang bảo trì',
    'bảo trì',
    'tạm đóng',
    'unavailable'
  ]

  if (maintenancePatterns.some(pattern => text.includes(pattern)) && text.includes('afk')) {
    scheduleRejoin(`afk maintenance detected: ${text}`, { allowAreaAdvance: true })
  }
}

function checkAfkPositionDrift(reason = 'interval') {
  if (!state.afkSuccess || !state.afkAnchorPosition || !state.currentPosition) return
  if (!canTriggerRejoinNow()) return

  const distance = positionDistance(state.currentPosition, state.afkAnchorPosition)
  if (distance < AFK_DRIFT_DISTANCE) return

  scheduleRejoin(
    `position drift detected (${reason}) distance=${distance.toFixed(2)} anchor=${formatPosition(state.afkAnchorPosition)} current=${formatPosition(state.currentPosition)}`,
    { immediate: true }
  )
}

function sendAntiIdle(reason = 'interval') {
  if (!state.afkSuccess || state.reconnecting || state.shuttingDown) return
  if (!state.client || state.client.entityId == null) return

  try {
    state.client.write('animate', {
      action_id: 'swing_arm',
      runtime_entity_id: state.client.entityId
    })
    state.lastActivityAt = new Date().toISOString()
    log(`[AFK] [SWING] [EID:${state.client.entityId}]`)
  } catch (err) {
    log(`[AFK] [SWING_FAIL] [REASON:${compactReason(err.message)}]`)
  }
}

function scheduleReconnect(reason) {
  if (state.shuttingDown || state.reconnecting || state.reconnectTimeout) return

  const alreadyLoggedIn = isAlreadyLoggedInReason(reason)
  if (alreadyLoggedIn) {
    state.alreadyLoggedInRetries += 1
    if (state.alreadyLoggedInRetries > ALREADY_LOGGED_IN_MAX_RETRIES) {
      log(`[RECONNECT] [STOP] [REASON:ALREADY_LOGGED_IN] [ATTEMPT:${state.alreadyLoggedInRetries - 1}]`)
      state.shuttingDown = true
      clearAfkTimeout()
      clearSpawnCommandTimeout()
      clearAnchorTimeout()
      clearReconnectTimeout()
      try {
        state.client?.close()
      } catch {}
      logger.close()
      process.exit(1)
    }
  } else {
    state.alreadyLoggedInRetries = 0
  }

  state.reconnecting = true
  state.reconnectAttempt += 1
  resetJoinState()
  state.client = null
  const reconnectDelay = alreadyLoggedIn ? ALREADY_LOGGED_IN_RECONNECT_DELAY_MS : RECONNECT_DELAY_MS
  log(`[RECONNECT] [SCHEDULED] [ATTEMPT:${state.reconnectAttempt}] [IN:${Math.floor(reconnectDelay / 1000)}s] [REASON:${compactReason(reason, 28)}]`)
  state.reconnectTimeout = setTimeout(() => {
    state.reconnectTimeout = null
    createAndWireClient()
  }, reconnectDelay)
}

function createAndWireClient() {
  clearReconnectTimeout()
  clearReconnectWatchdogTimeout()
  state.reconnecting = false

  const hasProxy = Boolean(process.env.PROXY_HOST)
  const clientOptions = {
    host: 'donutsmp.net',
    port: 19132,
    profilesFolder: authCacheDir,
    offline: false,
    skipPing: true,
    connectTimeout: 15000,
    // Dùng jsp-raknet khi có proxy (để override UDP socket qua SOCKS5).
    // Không proxy -> dùng raknet-native (C++ binding, ổn định hơn, mặc định).
    raknetBackend: hasProxy ? 'jsp-raknet' : 'raknet-native',
    useRaknetWorkers: false, // workerConnect trong rak.js chưa hoàn thiện, luôn dùng plainConnect
    onMsaCode: (data) => {
      const payload = { url: data.verification_uri, code: data.user_code }
      if (process.env.IS_WORKER === 'true' && process.send) {
        process.send({ type: 'msa_code', data: payload })
      }
      cloudEnqueue('msa_code', payload)
      log('================================================================')
      log('LOGIN XBOX REQUIRED')
      log(`URL: ${data.verification_uri}`)
      log(`CODE: ${data.user_code}`)
      log('================================================================')
    }
  }

  if (process.env.PROXY_HOST) {
    clientOptions.proxy = {
      host: process.env.PROXY_HOST,
      port: Number(process.env.PROXY_PORT),
      user: process.env.PROXY_USER,
      pass: process.env.PROXY_PASS
    }
    log(`[PROXY] Using ${clientOptions.proxy.host}:${clientOptions.proxy.port}`)
  }

  const client = bedrock.createClient(clientOptions)

  // Safety net: gắn error listener ngay để tránh crash nếu error fire trước khi handler chính gắn
  // (hoặc sau khi client.close() gọi removeAllListeners)
  client.on('error', err => {
    log(`[ERROR] [CLIENT_SAFETY] [REASON:${compactReason(err?.message || err, 36)}]`)
  })

  state.client = client
  helper.setClient(client)
  state.reconnectWatchdogTimeout = setTimeout(() => {
    if (state.shuttingDown) return
    if (state.client !== client) return
    if (state.spawned) return
    log(`[RECONNECT] [WATCHDOG] [TIMEOUT:${Math.floor(RECONNECT_WATCHDOG_MS / 1000)}s] [ACTION:CLOSE]`)
    try {
      client.close()
    } catch {}
  }, RECONNECT_WATCHDOG_MS)

  const originalWrite = client.write
  client.write = function wrappedWrite(name, params) {
    if (name === 'resource_pack_client_response') return
    originalWrite.call(this, name, params)
  }

  captureAccountIdentity(client)

  client.on('connect', () => {
    log('[EVENT] [CONNECT]')
  })

  client.on('join', () => {
    captureAccountIdentity(client)
    log('[EVENT] [JOIN]')
  })

  client.on('spawn', () => {
    log('[EVENT] [SPAWN]')
  })

  client.on('close', (...args) => {
    clearReconnectWatchdogTimeout()
    log('[EVENT] [CLOSE]')
    if (args.length) log(`[DETAIL] ${inspect(args)}`)
    state.client = null
    if (!state.shuttingDown) scheduleReconnect('close')
  })

  client.on('disconnect', packet => {
    clearReconnectWatchdogTimeout()
    const reason = packet?.message || packet?.reason || 'unknown'
    log(`[DISCONNECT] [REASON:${compactReason(reason, 36)}]`)
    log(`[DETAIL] ${inspect(packet)}`)
    state.client = null
    helper.saveSnapshot('disconnect', {
      afk_state: {
        area: state.currentTargetArea,
        success: state.afkSuccess
      }
    })
    if (!state.shuttingDown) scheduleReconnect(`disconnect:${packet?.message || packet?.reason || 'unknown'}`)
  })

  client.on('error', err => {
    clearReconnectWatchdogTimeout()
    log(`[ERROR] [CLIENT] [REASON:${compactReason(err?.message || err, 36)}]`)
    log(`[DETAIL] ${inspect(err)}`)
    helper.saveSnapshot('error', {
      afk_state: {
        area: state.currentTargetArea,
        success: state.afkSuccess,
        error: String(err?.message || err)
      }
    })
    state.client = null
    if (!state.shuttingDown) scheduleReconnect(`error:${err?.message || err}`)
  })

  client.on('packet', packet => {
    const name = packet.data.name
    const params = packet.data.params

    if (name === 'network_stack_latency' && params.needs_response) {
      const signedTimestamp = BigInt.asIntN(64, params.timestamp)
      const responseTimestamp = BigInt.asUintN(64, signedTimestamp * 1000000n)
      originalWrite.call(client, 'network_stack_latency', {
        timestamp: responseTimestamp,
        needs_response: false
      })
    }

    if (name === 'resource_packs_info') {
      log('[PKT] [RESOURCE_PACKS_INFO]')
      originalWrite.call(client, 'resource_pack_client_response', {
        response_status: 'have_all_packs',
        resourcepackids: []
      })
    }

    if (name === 'resource_pack_stack') {
      log('[PKT] [RESOURCE_PACK_STACK]')
      originalWrite.call(client, 'resource_pack_client_response', {
        response_status: 'completed',
        resourcepackids: []
      })
    }

    if (name === 'start_game') {
      clearReconnectWatchdogTimeout()
      log(`[PKT] [START_GAME] [EID:${params.runtime_entity_id}]`)
      client.startGameData = params
      updateCurrentPosition(params.player_position, 'start_game')
      helper.sendInitializedOnce('start_game')
    }

    if (name === 'play_status') {
      log(`[PKT] [PLAY_STATUS] [${String(params.status || 'unknown').toUpperCase()}]`)
      if (params.status === 'player_spawn' && !state.spawned) {
        state.spawned = true
        state.alreadyLoggedInRetries = 0
        startLocalPlaytimeSession()
        helper.sendInitializedOnce('player_spawn')
        state.waitingForAutoAssign = true
        clearSpawnCommandTimeout()
        state.spawnCommandTimeout = setTimeout(() => {
          state.spawnCommandTimeout = null
          if (state.afkSuccess) return
          state.waitingForAutoAssign = false
          tryJoinCurrentArea()
        }, Math.max(AFK_COMMAND_DELAY_MS, AFK_AUTO_ASSIGN_GRACE_MS))
      }
    }

    if (name === 'container_open') {
      helper.openContainer(params)
      helper.saveSnapshot('container_open')
    }

    if (name === 'inventory_content' && Array.isArray(params.input)) {
      helper.updateInventoryContent(params.window_id, params.input)
    }

    if (name === 'inventory_slot') {
      helper.updateInventorySlot(params.window_id, params.slot, params.item || params)
    }

    if (name === 'move_player') {
      const runtimeId = params.runtime_id ?? params.runtime_entity_id
      if (client.entityId != null && String(runtimeId) === String(client.entityId)) {
        updateCurrentPosition(params.position, `move_player:${params.mode || 'unknown'}`)
        checkAfkPositionDrift(`move_player:${params.mode || 'unknown'}`)
      }
    }

    if (name === 'set_display_objective') {
      updateScoreboardObjective(params)
    }

    if (name === 'set_score') {
      updateScoreboardEntries(params)
      refreshShardState()
    }

    if (name === 'text') {
      const rawMessage = params.message || ''
      const cleanMessage = stripMcColorCodes(rawMessage)
      const sourceName = String(params.source_name || 'System').toUpperCase()
      // Tắt toàn bộ log [CHAT] [SYSTEM] — quá spam, không cần thiết.
      if (sourceName !== 'SYSTEM') {
        log(`[CHAT] [${sourceName}] ${cleanMessage}`)
      }

      if (!state.afkSuccess && state.waitingForAutoAssign) {
        const autoAssignedArea = detectAutoAssignedAfkArea(cleanMessage)
        if (autoAssignedArea != null) {
          log(`[AFK] [AUTO_ASSIGN] [AFK:${autoAssignedArea}]`)
          markAutoAssignedAfk(autoAssignedArea, normalizeChat(cleanMessage))
          return
        }
      }

      if (state.afkSuccess) {
        handlePostSuccessChat(cleanMessage)
      }

      if (state.afkSuccess) return
      if (!state.afkAttemptInFlight || state.currentTargetArea == null) return

      const result = buildAfkAnalyzer(state.currentTargetArea)(cleanMessage)
      if (!result) return

      if (result.type === 'success') {
        markAfkSuccess(result.text)
        return
      }

      if (result.type === 'full') {
        moveToNextArea(result.text)
        return
      }

      if (result.type === 'failure') {
        log(`[AFK] [FAILED] [AFK:${state.currentTargetArea}] [REASON:${compactReason(result.text)}]`)
        moveToNextArea(result.text)
      }
    }
  })
  return client
}

setInterval(() => {
  const current = state.currentTargetArea == null ? 'none' : state.currentTargetArea
  const status = state.afkSuccess ? 'SUCCESS' : (state.afkAttemptInFlight ? 'PENDING' : 'IDLE')
  const reconnectCount = state.reconnectAttempt || 0
  log(`[HEARTBEAT] [${status}] [AFK:${current}] [POS:${formatPosition(state.currentPosition)}] [RECONNECT:${reconnectCount}]`)
}, HEARTBEAT_MS)

setInterval(() => {
  sendAntiIdle('interval')
}, AFK_ANTI_IDLE_MS)

setInterval(() => {
  checkAfkPositionDrift('interval')
}, AFK_DRIFT_CHECK_MS)

setInterval(() => {
  scheduleDashboardBroadcast()
}, DASHBOARD_REFRESH_MS)

process.on('SIGINT', () => {
  log('--- SIGINT ---')
  state.shuttingDown = true
  stopLocalPlaytimeSession()
  clearAfkTimeout()
  clearSpawnCommandTimeout()
  clearAnchorTimeout()
  clearReconnectTimeout()
  clearReconnectWatchdogTimeout()
  helper.saveSnapshot('sigint', {
    afk_state: {
      area: state.currentTargetArea,
      success: state.afkSuccess
    }
  })
  try {
    state.client?.close()
  } catch {}
  try {
    dashboardServer?.close()
  } catch {}
  logger.close()
  process.exit(0)
})

if (process.stdin && process.stdin.isTTY) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    const commands = String(chunk || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    for (const command of commands) {
      handleConsoleCommand(command)
    }
  })
}

// Chỉ mở dashboard HTTP server khi chạy local standalone (không phải worker IPC, không phải cloud)
if (process.env.IS_WORKER !== 'true' && !CLOUD_MODE) {
  startDashboardServer()
}

// Cloud mode: lên lịch tự thoát trước khi GitHub Actions kill (max 6h)
if (CLOUD_MODE) {
  const durationSec = Number(process.env.RUN_DURATION_SEC || 20400) // mặc định 5h40m
  log(`[CLOUD] [MODE:ACTIVE] [DURATION:${durationSec}s] [WEBHOOK:${WEBHOOK_URL ? 'SET' : 'NONE'}]`)

  setTimeout(async () => {
    log(`[CLOUD] [AUTO_EXIT] [ELAPSED:${durationSec}s] [REASON:DURATION_REACHED]`)
    state.shuttingDown = true
    stopLocalPlaytimeSession()
    try { state.client?.close() } catch {}
    await flushCloudQueue()
    setTimeout(() => process.exit(0), 1500)
  }, durationSec * 1000)
}

// SIGTERM handler (GitHub Actions gửi khi timeout-minutes reached, hoặc khi cancel run)
process.on('SIGTERM', async () => {
  log('[CLOUD] [SIGTERM] Graceful shutdown')
  state.shuttingDown = true
  stopLocalPlaytimeSession()
  try { state.client?.close() } catch {}
  await flushCloudQueue()
  setTimeout(() => process.exit(0), 1500)
})

;(async () => {
  if (CLOUD_MODE) {
    const result = await reportIpAndCheck()
    if (result && result.allowed === false) {
      log(`[CLOUD] [IP_BLOCKED] [REASON:${result.reason || 'duplicate IP'}]`)
      log('[CLOUD] [ABORT] Không kết nối Minecraft, thoát ngay')
      await flushCloudQueue()
      setTimeout(() => process.exit(2), 1500)
      return
    }
  }
  createAndWireClient()
})()
