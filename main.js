const fs = require('fs')
const path = require('path')
const util = require('util')
const crypto = require('crypto')
const EventEmitter = require('events')
const bedrock = require('bedrock-protocol')

function inspect(value, depth = null) {
  return util.inspect(value, {
    depth,
    colors: false,
    maxArrayLength: null,
    maxStringLength: null,
    breakLength: 140
  })
}

function jsonSafeReplacer(key, value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}

function safeGet(obj, pathParts, fallback = undefined) {
  try {
    let cur = obj
    for (const key of pathParts) {
      if (cur == null) return fallback
      cur = cur[key]
    }
    return cur === undefined ? fallback : cur
  } catch {
    return fallback
  }
}

function nbtRoot(item) {
  return (
    safeGet(item, ['extra', 'nbt', 'nbt']) ||
    safeGet(item, ['nbt_data']) ||
    safeGet(item, ['nbt']) ||
    null
  )
}

function extractDisplayName(item) {
  const root = nbtRoot(item)
  return (
    safeGet(root, ['value', 'display', 'value', 'Name', 'value']) ||
    safeGet(root, ['value', 'display', 'value', 'name', 'value']) ||
    null
  )
}

function extractLore(item) {
  const root = nbtRoot(item)
  const loreA = safeGet(root, ['value', 'display', 'value', 'Lore', 'value', 'value'])
  if (Array.isArray(loreA)) return loreA
  const loreB = safeGet(root, ['value', 'display', 'value', 'lore', 'value', 'value'])
  if (Array.isArray(loreB)) return loreB
  return []
}

function stripMcColorCodes(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/Ã‚Â§[0-9a-fk-or]/gi, '')
    .replace(/Â§[0-9a-fk-or]/gi, '')
    .replace(/§[0-9a-fk-or]/gi, '')
}

function normalizeChat(text) {
  return stripMcColorCodes(String(text || ''))
    .replace(/[ᴀᴬⓐ🄰Ａ]/g, 'a')
    .replace(/[ꜰғᶠⓕ🄵Ｆ]/g, 'f')
    .replace(/[ᴋᵏⓚ🄺Ｋ]/g, 'k')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function summarizeItem(item, slot) {
  if (!item || item.network_id === 0) {
    return { slot, empty: true, network_id: 0 }
  }

  const customName = extractDisplayName(item)
  const lore = extractLore(item)

  return {
    slot,
    empty: false,
    network_id: item.network_id,
    count: item.count,
    metadata: item.metadata,
    block_runtime_id: item.block_runtime_id,
    stack_id: item.stack_id,
    custom_name_raw: customName,
    custom_name_clean: stripMcColorCodes(customName),
    lore_raw: lore,
    lore_clean: lore.map(stripMcColorCodes),
    has_nbt: !!nbtRoot(item),
    raw_item: item
  }
}

function isPlayerWindow(windowId) {
  return ['inventory', 'armor', 'offhand', 'ui', 'hotbar', '0'].includes(String(windowId))
}

function makeAirItem() {
  return {
    network_id: 0,
    count: 0,
    metadata: 0,
    has_stack_id: 0,
    block_runtime_id: 0,
    extra: {
      has_nbt: false,
      can_place_on: [],
      can_destroy: []
    }
  }
}

function cloneForPacket(obj) {
  return JSON.parse(JSON.stringify(obj, jsonSafeReplacer))
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
  return dirPath
}

function getAuthCacheDir(dirName = '.auth-cache') {
  return ensureDir(path.resolve(process.cwd(), dirName))
}

function getSummarySignature(items) {
  return items
    .filter(item => item && !item.empty)
    .map(item => `${item.slot}|${item.network_id}|${item.custom_name_clean || ''}|${(item.lore_clean || []).join(' / ')}`)
    .join(' || ')
}

function translateWindowId(windowId) {
  if (typeof windowId === 'number') return windowId
  const map = { inventory: 0, first: 1, second: 2, third: 3, fourth: 4 }
  return map[String(windowId).toLowerCase()] ?? windowId
}

function makeFullContainerName(windowId) {
  const numericWindowId = translateWindowId(windowId)
  if (numericWindowId === 0 || String(windowId) === 'inventory') {
    return { container_id: 'inventory' }
  }
  return {
    container_id: 'container',
    dynamic_container_id: numericWindowId
  }
}

function makeStackRequestSlotInfo(windowId, slot, stackId) {
  return {
    slot_type: makeFullContainerName(windowId),
    slot,
    stack_id: stackId || 0
  }
}

function formatConsoleTime(date = new Date()) {
  return date.toTimeString().slice(0, 8)
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
}

function colorize(text, color) {
  return `${color}${text}${ANSI.reset}`
}

function normalizeLogMessage(message) {
  const trimmed = String(message || '').trim()
  if (!trimmed) return '[LOG]'

  const eventMatch = trimmed.match(/^---\s*Event:\s*(.+?)\s*---$/i)
  if (eventMatch) return `[EVENT] [${String(eventMatch[1]).trim().toUpperCase()}]`

  if (/join server/i.test(trimmed)) return '[EVENT] [JOIN]'
  if (/kick\/disconnect/i.test(trimmed)) return '[DISCONNECT]'
  if (/resource_packs_info/i.test(trimmed)) return '[PKT] [RESOURCE_PACKS_INFO]'
  if (/resource_pack_stack/i.test(trimmed)) return '[PKT] [RESOURCE_PACK_STACK]'

  const wrappedMatch = trimmed.match(/^---\s*(.+?)\s*---$/)
  if (wrappedMatch) return `[LOG] ${wrappedMatch[1].trim()}`

  return trimmed
}

function getTagColor(tagContent) {
  const normalized = String(tagContent || '').trim().toUpperCase()
  const key = normalized.split(':')[0]

  if (['ERROR', 'DISCONNECT', 'FAILED', 'FAIL', 'KICK'].includes(key)) return ANSI.red
  if (['SUCCESS', 'CONNECTED', 'JOIN', 'SPAWN', 'SWING'].includes(key)) return ANSI.green
  if (['RECONNECT', 'WARN', 'WAIT', 'PENDING', 'TIMEOUT'].includes(key)) return ANSI.yellow
  if (['PKT', 'EVENT', 'INIT', 'COMMAND', 'CLICK'].includes(key)) return ANSI.blue
  if (['CHAT', 'TEXT', 'SYSTEM'].includes(key)) return ANSI.magenta
  if (['HEARTBEAT', 'AFK'].includes(key)) return ANSI.cyan
  if (['SNAPSHOT', 'GUI', 'POS', 'EID', 'ATTEMPT', 'IN', 'REASON', 'WINDOW', 'AREA', 'DETAIL'].includes(key)) return ANSI.gray
  return ANSI.white
}

function colorizeBracketTags(message) {
  return message.replace(/\[([^\]]+)\]/g, (_, content) => colorize(`[${content}]`, getTagColor(content)))
}

function formatLogLine(message, at = new Date()) {
  const normalized = normalizeLogMessage(message)
  const timestamp = colorize(formatConsoleTime(at), ANSI.dim)
  return `${timestamp} ${colorizeBracketTags(normalized)}`
}

function createLogger(logFile = null, options = {}) {
  void logFile
  void options

  function log(...args) {
    const normalized = normalizeLogMessage(util.format(...args))
    if (normalized.startsWith('[SNAPSHOT]')) return
    const output = formatLogLine(normalized)
    process.stdout.write(output + '\n')
  }

  function close() {
    return undefined
  }

  return { log, close, stream: null }
}

function loadJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function saveJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, jsonSafeReplacer, 2), 'utf8')
  return filePath
}

function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return []
  return fs.readdirSync(dirPath)
    .filter(file => file.endsWith('.json'))
    .map(file => path.join(dirPath, file))
}

function createDefaultSessionConfig(partial = {}) {
  const sessionId = partial.sessionId || partial.id || crypto.randomUUID()
  return {
    sessionId,
    label: partial.label || sessionId,
    username: partial.username || 'BotTest123',
    host: partial.host || 'donutsmp.net',
    port: Number(partial.port || 19132),
    autoConnect: Boolean(partial.autoConnect),
    authCacheDir: partial.authCacheDir || getAuthCacheDir(path.join('.auth-cache', sessionId)),
    proxy: partial.proxy || {
      enabled: false,
      type: 'socks5',
      host: '',
      port: '',
      username: '',
      password: ''
    },
    meta: partial.meta || {}
  }
}

function createDeferred(timeoutMs, timeoutMessage) {
  let settled = false
  let timeout = null
  let resolveFn = null
  let rejectFn = null
  const promise = new Promise((resolve, reject) => {
    resolveFn = value => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolve(value)
    }
    rejectFn = error => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      reject(error)
    }
  })

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      rejectFn(new Error(timeoutMessage || `Timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  }

  return { promise, resolve: resolveFn, reject: rejectFn }
}

function resolveClientEntityId(client) {
  if (!client) return null
  return client.entityId ?? safeGet(client, ['startGameData', 'runtime_entity_id'], null)
}

class BedrockTaskHelper {
  constructor(options = {}) {
    const {
      client = null,
      log = console.log,
      snapshotFile = null,
      state = {}
    } = options

    this.client = client
    this.log = (...args) => log(...args)
    this.snapshotFile = snapshotFile
    this.itemStackRequestId = state.itemStackRequestId || 1
    this.initializedSent = false
    this.currentContainer = state.currentContainer || null
    this.containerSnapshots = state.containerSnapshots || {}
  }

  setClient(client) {
    this.client = client
  }

  createRuntimeState(extra = {}) {
    return {
      initializedSent: this.initializedSent,
      itemStackRequestId: this.itemStackRequestId,
      currentContainer: this.currentContainer,
      containerSnapshots: this.containerSnapshots,
      ...extra
    }
  }

  ensureContainerSnapshot(windowId) {
    const key = String(windowId)
    if (!this.containerSnapshots[key]) {
      this.containerSnapshots[key] = {
        meta: {
          window_id: windowId,
          window_type: this.currentContainer?.window_id === windowId ? this.currentContainer.window_type : null,
          created_at: new Date().toISOString()
        },
        slots: [],
        updates: []
      }
    }
    return this.containerSnapshots[key]
  }

  ensureNamedSnapshot(key, meta = {}) {
    if (!this.containerSnapshots[key]) {
      this.containerSnapshots[key] = {
        meta: {
          created_at: new Date().toISOString(),
          ...meta
        },
        slots: [],
        updates: []
      }
    }
    return this.containerSnapshots[key]
  }

  saveSnapshot(reason = 'manual', extra = {}) {
    if (!this.snapshotFile) return null

    const payload = {
      saved_at: new Date().toISOString(),
      reason,
      current_container: this.currentContainer,
      snapshots: this.containerSnapshots,
      ...extra
    }

    fs.writeFileSync(this.snapshotFile, JSON.stringify(payload, jsonSafeReplacer, 2), 'utf8')
    this.log(`[SNAPSHOT] Saved ${this.snapshotFile} (${reason})`)
    return payload
  }

  logContainerSummary(windowId, prefix = 'GUI') {
    const snap = this.containerSnapshots[String(windowId)]
    if (!snap) return

    this.log(`========== ${prefix} window_id=${windowId} ==========`)

    const nonEmpty = (snap.slots || []).filter(item => item && !item.empty)
    if (nonEmpty.length === 0) {
      this.log('No non-empty items in snapshot.')
    } else {
      for (const item of nonEmpty) {
        this.log(
          `[ITEM] slot=${item.slot} network_id=${item.network_id} count=${item.count || 1} name="${item.custom_name_clean || ''}" lore=${JSON.stringify(item.lore_clean || [])}`
        )
      }
    }

    this.log('===============================================')
  }

  openContainer(params, source = 'container_open') {
    this.currentContainer = {
      window_id: params.window_id,
      window_type: params.window_type,
      opened_at: new Date().toISOString(),
      source
    }

    const snap = this.ensureContainerSnapshot(params.window_id)
    snap.meta.window_type = params.window_type
    snap.meta.open_raw = {
      window_id: params.window_id,
      window_type: params.window_type,
      coordinates: params.coordinates,
      runtime_entity_id: typeof params.runtime_entity_id === 'bigint'
        ? params.runtime_entity_id.toString()
        : params.runtime_entity_id
    }

    return snap
  }

  updateInventoryContent(windowId, items) {
    const summarized = items.map((item, index) => summarizeItem(item, index))
    const snap = this.ensureContainerSnapshot(windowId)
    snap.slots = summarized
    return summarized
  }

  updateInventorySlot(windowId, slot, item) {
    const summarized = summarizeItem(item, slot)
    const snap = this.ensureContainerSnapshot(windowId)
    if (!Array.isArray(snap.slots)) snap.slots = []
    snap.slots[slot] = summarized
    return summarized
  }

  getWindowItems(windowId) {
    return this.containerSnapshots[String(windowId)]?.slots || []
  }

  getItemAt(windowId, slot) {
    return this.getWindowItems(windowId)[slot] || null
  }

  findSlotByName(windowId, needle) {
    const loweredNeedle = String(needle).toLowerCase()
    return this.getWindowItems(windowId).find(item => {
      if (!item || item.empty) return false
      return String(item.custom_name_clean || '').toLowerCase().includes(loweredNeedle)
    }) || null
  }

  findSlotsByPredicate(windowId, predicate) {
    return this.getWindowItems(windowId).filter(item => item && !item.empty && predicate(item))
  }

  captureWindowTransition(previousWindowId, windowId, summarized, keyPrefix = 'transition') {
    if (isPlayerWindow(windowId)) return null

    const newSignature = getSummarySignature(summarized)
    if (!newSignature) return null

    const previousSignature = getSummarySignature(this.getWindowItems(previousWindowId))
    if (String(windowId) === String(previousWindowId) && newSignature === previousSignature) {
      return null
    }

    const key = `${keyPrefix}_window_${String(windowId)}`
    const snap = this.ensureNamedSnapshot(key, {
      source_window_id: windowId,
      source: 'captured_transition',
      captured_at: new Date().toISOString()
    })

    snap.slots = summarized
    snap.updates.push({
      type: 'inventory_content_after_transition',
      at: new Date().toISOString(),
      raw_window_id: windowId
    })

    return { key, snapshot: snap }
  }

  sendInitializedOnce(reason = 'manual') {
    if (!this.client) throw new Error('client is not set')
    if (this.initializedSent) return false
    const entityId = resolveClientEntityId(this.client)
    if (entityId == null) {
      this.log(`[INIT] Skip set_local_player_as_initialized: missing entityId (${reason})`)
      return false
    }

    this.initializedSent = true
    this.client.write('set_local_player_as_initialized', {
      runtime_entity_id: entityId
    })
    this.log(`[INIT] Sent set_local_player_as_initialized (${reason}) entityId=${entityId}`)
    return true
  }

  sendCommand(command) {
    if (!this.client) throw new Error('client is not set')
    const entityId = resolveClientEntityId(this.client)
    if (!this.client.profile?.uuid || entityId == null) {
      throw new Error(`Cannot send command without profile uuid/entityId: ${command}`)
    }

    this.client.write('command_request', {
      command,
      origin: {
        type: 'player',
        uuid: this.client.profile.uuid,
        request_id: '',
        player_entity_id: entityId
      },
      internal: false,
      version: '1'
    })

    this.log(`[COMMAND] ${command}`)
  }

  sendItemStackRequest(windowId, slot, itemSummary, actions = null) {
    if (!this.client) throw new Error('client is not set')

    const stackId = itemSummary?.stack_id || 0
    const numericWindowId = translateWindowId(windowId)

    const defaultActions = [
      {
        type_id: 'take',
        count: itemSummary?.count || 1,
        source: makeStackRequestSlotInfo(windowId, slot, stackId),
        destination: {
          slot_type: { container_id: 'cursor' },
          slot: 0,
          stack_id: 0
        }
      }
    ]

    this.client.write('item_stack_request', {
      requests: [
        {
          request_id: this.itemStackRequestId++,
          actions: actions || defaultActions,
          custom_names: [],
          cause: 'chat_public'
        }
      ]
    })

    this.log(`[CLICK] item_stack_request window=${windowId}(->${numericWindowId}) slot=${slot} stack_id=${stackId}`)
    return this.itemStackRequestId - 1
  }

  clickWindowSlot(windowId, slot, itemSummary = null) {
    const summary = itemSummary || this.getItemAt(windowId, slot)
    if (!summary || summary.empty) {
      throw new Error(`Cannot click empty or missing slot ${slot} in window ${windowId}`)
    }
    return this.sendItemStackRequest(windowId, slot, summary)
  }

  sendDynamicTakeRequest(windowId, slot, itemSummary = null) {
    const summary = itemSummary || this.getItemAt(windowId, slot)
    if (!summary || summary.empty) {
      throw new Error(`Cannot send dynamic request for empty or missing slot ${slot} in window ${windowId}`)
    }

    return this.sendItemStackRequest(windowId, slot, summary, [
      {
        type_id: 'take',
        count: summary.count || 1,
        source: {
          slot_type: {
            container_id: 'dynamic',
            dynamic_container_id: translateWindowId(windowId)
          },
          slot,
          stack_id: summary.stack_id || 0
        },
        destination: {
          slot_type: { container_id: 'cursor' },
          slot: 0,
          stack_id: 0
        }
      }
    ])
  }

  sendLegacyInventoryTransactionClick(windowId, slot, itemSummary = null, forceNumericWindowId = false) {
    if (!this.client) throw new Error('client is not set')

    const summary = itemSummary || this.getItemAt(windowId, slot)
    if (!summary || summary.empty) {
      throw new Error(`Cannot send legacy click for empty or missing slot ${slot} in window ${windowId}`)
    }

    const inventoryId = forceNumericWindowId ? translateWindowId(windowId) : windowId

    this.client.write('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0, legacy_transactions: [] },
        transaction_type: 'normal',
        actions: [
          {
            source_type: 'container',
            inventory_id: inventoryId,
            slot,
            old_item: cloneForPacket(summary.raw_item),
            new_item: makeAirItem()
          }
        ],
        transaction_data: 'void'
      }
    })

    this.log(`[CLICK] inventory_transaction window=${windowId} inventory_id=${inventoryId} slot=${slot}`)
  }

  extractFormData(packet) {
    if (!packet?.data) return null
    try {
      return JSON.parse(packet.data)
    } catch {
      return packet.data
    }
  }
}

class TaskRegistry {
  constructor() {
    this.tasks = new Map()
  }

  register(task) {
    if (!task?.id || typeof task.run !== 'function') {
      throw new Error('Invalid task registration')
    }
    this.tasks.set(task.id, task)
    return task
  }

  get(taskId) {
    return this.tasks.get(taskId) || null
  }

  list() {
    return Array.from(this.tasks.values()).map(task => ({
      id: task.id,
      title: task.title || task.id,
      description: task.description || ''
    }))
  }
}

class BotSession extends EventEmitter {
  constructor(manager, config) {
    super()
    this.manager = manager
    this.config = createDefaultSessionConfig(config)
    this.sessionId = this.config.sessionId
    this.client = null
    this.originalWrite = null
    this.logger = createLogger()
    this.helper = new BedrockTaskHelper({
      log: (...args) => this.log(...args),
      snapshotFile: path.join(this.manager.logsSessionDir, `${this.sessionId}.snapshot.json`)
    })
    this.logBuffer = []
    this.disposers = new Set()
    this.reconnectTimeout = null
    this.taskCleanup = null
    this.playerEntities = {}
    this.state = this.createInitialState()
  }

  createInitialState() {
    return {
      connected: false,
      joining: false,
      spawned: false,
      reconnecting: false,
      status: 'idle',
      profile: null,
      entityId: null,
      currentPosition: null,
      inventory: [],
      scoreboardEntries: [],
      scoreboardObjectives: [],
      lastText: null,
      currentTask: null,
      lastTaskResult: null,
      lastError: null,
      currentContainer: null,
      lastDisconnect: null,
      proxyReady: !this.config.proxy?.enabled
    }
  }

  getSnapshot() {
    return {
      sessionId: this.sessionId,
      config: this.config,
      state: {
        ...this.state,
        currentContainer: this.helper.currentContainer
      },
      tasks: this.manager.registry.list(),
      recentLogs: this.logBuffer.slice(-200)
    }
  }

  emitEvent(type, payload = {}) {
    const event = {
      type,
      sessionId: this.sessionId,
      at: new Date().toISOString(),
      ...payload
    }
    this.emit('event', event)
    this.manager.broadcast('session_event', event)
    return event
  }

  pushLog(line) {
    this.logBuffer.push({
      at: new Date().toISOString(),
      line
    })
    if (this.logBuffer.length > 500) this.logBuffer.splice(0, this.logBuffer.length - 500)
    this.manager.broadcast('session_log', {
      sessionId: this.sessionId,
      at: new Date().toISOString(),
      line
    })
  }

  log(...args) {
    const line = util.format(...args)
    this.logger.log(`[${this.sessionId}] ${line}`)
    this.pushLog(line)
  }

  setState(patch) {
    this.state = { ...this.state, ...patch }
    this.emitEvent('state', { state: this.state })
  }

  getTaskContext() {
    return {
      sessionId: this.sessionId,
      config: this.config,
      state: this.state,
      helper: this.helper
    }
  }

  saveTaskSnapshot(taskId, payload) {
    const filePath = path.join(this.manager.logsSessionDir, `${this.sessionId}.${taskId}.json`)
    saveJsonFile(filePath, {
      saved_at: new Date().toISOString(),
      sessionId: this.sessionId,
      taskId,
      payload
    })
    return filePath
  }

  clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  cleanupListeners() {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {}
    }
    this.disposers.clear()
  }

  resetRuntimeState({ keepTask = false } = {}) {
    const currentTask = keepTask ? this.state.currentTask : null
    const lastTaskResult = keepTask ? this.state.lastTaskResult : this.state.lastTaskResult
    this.state = {
      ...this.createInitialState(),
      currentTask,
      lastTaskResult
    }
    this.helper.initializedSent = false
    this.helper.currentContainer = null
    this.helper.setClient(null)
    this.playerEntities = {}
  }

  buildClientOptions() {
    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      profilesFolder: this.config.authCacheDir,
      offline: false,
      skipPing: true,
      connectTimeout: 15000,
      onMsaCode: data => {
        this.emitEvent('msa_code', {
          verification_uri: data.verification_uri,
          user_code: data.user_code
        })
        this.log('LOGIN XBOX REQUIRED')
        this.log(`URL: ${data.verification_uri}`)
        this.log(`CODE: ${data.user_code}`)
      }
    }

    if (this.config.proxy?.enabled) {
      this.log(`Proxy configured but transport wiring is not implemented yet: ${inspect(this.config.proxy)}`)
      this.setState({ proxyReady: false })
    } else {
      this.setState({ proxyReady: true })
    }

    return options
  }

  async connect() {
    if (this.client) return this.getSnapshot()
    this.clearReconnectTimeout()
    this.setState({
      status: 'connecting',
      joining: true,
      reconnecting: false,
      lastError: null
    })

    const client = bedrock.createClient(this.buildClientOptions())
    this.client = client
    this.helper.setClient(client)
    this.originalWrite = client.write
    client.write = (name, params) => {
      if (name === 'resource_pack_client_response') return
      this.originalWrite.call(client, name, params)
    }

    this.wireClient(client)
    this.emitEvent('connected_request', { config: this.config })
    return this.getSnapshot()
  }

  disconnect(reason = 'manual') {
    this.clearReconnectTimeout()
    this.cleanupListeners()
    this.setState({
      connected: false,
      joining: false,
      spawned: false,
      status: 'disconnected',
      reconnecting: false,
      lastDisconnect: { reason, at: new Date().toISOString() }
    })
    if (this.client) {
      try {
        this.client.close()
      } catch {}
    }
    this.client = null
    this.helper.setClient(null)
    this.emitEvent('disconnected', { reason })
  }

  scheduleReconnect(reason = 'close') {
    if (!this.config.autoConnect) return
    if (this.reconnectTimeout) return
    this.setState({
      reconnecting: true,
      status: 'reconnecting',
      lastDisconnect: { reason, at: new Date().toISOString() }
    })
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect().catch(error => {
        this.log(`[RECONNECT] [FAILED] [REASON:${String(error.message || error).toUpperCase()}]`)
        this.setState({ lastError: error.message, reconnecting: false, status: 'error' })
      })
    }, 10000)
  }

  wireClient(client) {
    client.on('connect', () => {
      this.log('[EVENT] [CONNECT]')
    })

    client.on('join', () => {
      this.log('[EVENT] [JOIN]')
      this.setState({ connected: true, joining: false, status: 'joined' })
    })

    client.on('spawn', () => {
      this.log('[EVENT] [SPAWN]')
    })

    client.on('close', (...args) => {
      this.log('[EVENT] [CLOSE]')
      if (args.length) this.log(`[DETAIL] ${inspect(args)}`)
      this.cleanupListeners()
      this.client = null
      this.helper.setClient(null)
      this.setState({
        connected: false,
        joining: false,
        spawned: false,
        status: 'closed',
        lastDisconnect: {
          reason: 'close',
          details: args,
          at: new Date().toISOString()
        }
      })
      this.scheduleReconnect('close')
    })

    client.on('disconnect', packet => {
      this.log(`[DISCONNECT] [REASON:${String(packet?.message || packet?.reason || 'disconnect').toUpperCase()}]`)
      this.log(`[DETAIL] ${inspect(packet)}`)
      this.setState({
        connected: false,
        status: 'disconnect',
        lastDisconnect: {
          reason: packet?.message || packet?.reason || 'disconnect',
          at: new Date().toISOString()
        }
      })
      this.emitEvent('disconnect_packet', { packet })
      this.scheduleReconnect(packet?.message || packet?.reason || 'disconnect')
    })

    client.on('error', error => {
      this.log(`[ERROR] [CLIENT] [REASON:${String(error?.message || error).toUpperCase()}]`)
      this.log(`[DETAIL] ${inspect(error)}`)
      this.setState({
        status: 'error',
        lastError: String(error?.message || error)
      })
      this.emitEvent('error', { error: String(error?.message || error) })
    })

    client.on('packet', packet => this.handlePacket(packet))
  }

  handlePacket(packet) {
    const name = packet.data.name
    const params = packet.data.params
    this.emitEvent('packet', { name })

    if (name === 'network_stack_latency' && params.needs_response) {
      const signedTimestamp = BigInt.asIntN(64, params.timestamp)
      const responseTimestamp = BigInt.asUintN(64, signedTimestamp * 1000000n)
      this.originalWrite.call(this.client, 'network_stack_latency', {
        timestamp: responseTimestamp,
        needs_response: false
      })
    }

    if (name === 'resource_packs_info') {
      this.log('[PKT] [RESOURCE_PACKS_INFO]')
      this.originalWrite.call(this.client, 'resource_pack_client_response', {
        response_status: 'have_all_packs',
        resourcepackids: []
      })
    }

    if (name === 'resource_pack_stack') {
      this.log('[PKT] [RESOURCE_PACK_STACK]')
      this.originalWrite.call(this.client, 'resource_pack_client_response', {
        response_status: 'completed',
        resourcepackids: []
      })
    }

    if (name === 'start_game') {
      this.client.startGameData = params
      this.setState({
        entityId: params.runtime_entity_id,
        currentPosition: params.player_position || null,
        status: 'start_game'
      })
      this.log(`[PKT] [START_GAME] [EID:${params.runtime_entity_id}]`)
      this.helper.sendInitializedOnce('start_game')
    }

    if (name === 'play_status') {
      this.log(`[PKT] [PLAY_STATUS] [${String(params.status || 'unknown').toUpperCase()}]`)
      if (params.status === 'player_spawn') {
        this.setState({ spawned: true, status: 'spawned' })
        this.helper.sendInitializedOnce('player_spawn')
      }
    }

    if (name === 'container_open') {
      this.helper.openContainer(params)
      this.setState({ currentContainer: this.helper.currentContainer })
    }

    if (name === 'container_close') {
      this.log(`[GUI] [CLOSE] [WINDOW:${params.window_id}]`)
    }

    if (name === 'inventory_content' && Array.isArray(params.input)) {
      const summarized = this.helper.updateInventoryContent(params.window_id, params.input)
      if (isPlayerWindow(params.window_id)) {
        this.setState({ inventory: summarized })
      }
    }

    if (name === 'inventory_slot') {
      const summarized = this.helper.updateInventorySlot(params.window_id, params.slot, params.item || params)
      if (isPlayerWindow(params.window_id)) {
        const inventory = this.helper.getWindowItems(params.window_id)
        this.setState({ inventory })
      }
      return summarized
    }

    if (name === 'move_player') {
      const runtimeId = params.runtime_id ?? params.runtime_entity_id
      const localEntityId = this.state.entityId ?? resolveClientEntityId(this.client)
      if (localEntityId != null && String(runtimeId) === String(localEntityId)) {
        this.setState({
          currentPosition: {
            x: Number(params.position.x),
            y: Number(params.position.y),
            z: Number(params.position.z)
          }
        })
      }
    }

    if (name === 'add_player') {
      const entityId = String(params.runtime_id || params.unique_id || '')
      if (entityId) {
        this.playerEntities[entityId] = {
          entity_id: entityId,
          username: params.username,
          uuid: params.uuid,
          position: params.position || null
        }
      }
    }

    if (name === 'move_entity_absolute') {
      const entityId = String(params.runtime_entity_id || '')
      if (entityId && this.playerEntities[entityId]) {
        this.playerEntities[entityId].position = params.position
      }
    }

    if (name === 'remove_entity') {
      const entityId = String(params.entity_unique_id || '')
      if (entityId) delete this.playerEntities[entityId]
    }

    if (name === 'set_display_objective') {
      const next = this.state.scoreboardObjectives.concat([params]).slice(-200)
      this.setState({ scoreboardObjectives: next })
    }

    if (name === 'set_score') {
      const next = this.state.scoreboardEntries.concat([{ at: new Date().toISOString(), params }]).slice(-500)
      this.setState({ scoreboardEntries: next })
    }

    if (name === 'text') {
      const message = params.message || ''
      this.setState({
        lastText: {
          raw: message,
          clean: stripMcColorCodes(message),
          normalized: normalizeChat(message),
          source: params.source_name || 'System',
          at: new Date().toISOString()
        }
      })
      this.log(`[CHAT] [${String(params.source_name || 'System').toUpperCase()}] ${stripMcColorCodes(message)}`)
    }
  }

  addTaskDisposer(dispose) {
    if (typeof dispose !== 'function') return
    const wrapped = () => {
      try {
        dispose()
      } catch {}
    }
    this.disposers.add(wrapped)
    return wrapped
  }

  waitForPacket(packetName, predicate = null, timeoutMs = 10000) {
    const deferred = createDeferred(timeoutMs, `Timed out waiting for packet ${packetName}`)
    const onPacket = packet => {
      const { name, params } = packet.data
      if (name !== packetName) return
      if (predicate && !predicate(params, packet)) return
      cleanup()
      deferred.resolve({ packet, params })
    }
    const cleanup = () => {
      if (this.client) this.client.off('packet', onPacket)
      this.disposers.delete(cleanup)
    }
    this.client.on('packet', onPacket)
    this.disposers.add(cleanup)
    return deferred.promise
  }

  waitForChat(matcher, timeoutMs = 10000) {
    return this.waitForPacket('text', params => {
      const raw = params.message || ''
      const clean = stripMcColorCodes(raw)
      const normalized = normalizeChat(raw)
      if (typeof matcher === 'function') return matcher({ raw, clean, normalized, params })
      if (matcher instanceof RegExp) return matcher.test(clean)
      if (typeof matcher === 'string') return normalized.includes(normalizeChat(matcher))
      return false
    }, timeoutMs).then(result => {
      const raw = result.params.message || ''
      return {
        raw,
        clean: stripMcColorCodes(raw),
        normalized: normalizeChat(raw),
        params: result.params
      }
    })
  }

  waitForWindowTransition(previousWindowId, timeoutMs = 10000) {
    return this.waitForPacket('inventory_content', params => {
      if (!Array.isArray(params.input)) return false
      const summarized = params.input.map((item, index) => summarizeItem(item, index))
      const captured = this.helper.captureWindowTransition(previousWindowId, params.window_id, summarized, 'task')
      return Boolean(captured)
    }, timeoutMs).then(({ params }) => ({
      windowId: params.window_id,
      items: this.helper.getWindowItems(params.window_id)
    }))
  }

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  getInventorySummary() {
    return this.state.inventory || []
  }

  getScoreboardSnapshot() {
    return {
      entries: this.state.scoreboardEntries || [],
      objectives: this.state.scoreboardObjectives || []
    }
  }

  getPlayerEntities() {
    return { ...this.playerEntities }
  }

  async sendCommand(command) {
    this.helper.sendCommand(command)
    return true
  }

  async clickWindowSlot(windowId, slot, itemSummary = null) {
    return this.helper.clickWindowSlot(windowId, slot, itemSummary)
  }

  async runTask(taskId, options = {}) {
    if (this.state.currentTask) {
      throw new Error(`Session ${this.sessionId} already running task ${this.state.currentTask.id}`)
    }
    const task = this.manager.registry.get(taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)

    const taskState = {
      id: task.id,
      title: task.title || task.id,
      startedAt: new Date().toISOString(),
      options
    }
    this.setState({ currentTask: taskState, status: `task:${task.id}` })
    this.emitEvent('task_started', { task: taskState })

    const context = {
      task,
      session: this,
      options,
      log: (...args) => this.log(`[TASK:${task.id}]`, ...args),
      progress: (phase, data = {}) => this.emitEvent('task_progress', { taskId: task.id, phase, data })
    }

    try {
      const result = await task.run(this, options, context)
      this.setState({
        currentTask: null,
        lastTaskResult: {
          ok: true,
          taskId: task.id,
          finishedAt: new Date().toISOString(),
          result
        },
        status: this.state.connected ? 'ready' : 'idle'
      })
      this.emitEvent('task_finished', { taskId: task.id, result })
      return result
    } catch (error) {
      const result = {
        ok: false,
        taskId: task.id,
        code: error.code || 'TASK_FAILED',
        message: error.message || String(error)
      }
      this.setState({
        currentTask: null,
        lastTaskResult: result,
        lastError: result.message,
        status: 'task_failed'
      })
      this.emitEvent('task_failed', { taskId: task.id, error: result })
      throw error
    }
  }

  stopTask(reason = 'manual') {
    this.emitEvent('task_stop_requested', { reason })
    this.setState({ currentTask: null, status: this.state.connected ? 'ready' : 'idle' })
  }
}

class BotManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.baseDir = path.resolve(options.baseDir || process.cwd())
    this.dataDir = ensureDir(path.join(this.baseDir, 'data'))
    this.sessionsDir = ensureDir(path.join(this.dataDir, 'sessions'))
    this.logsDir = ensureDir(path.join(this.baseDir, 'logs'))
    this.logsSessionDir = ensureDir(path.join(this.logsDir, 'sessions'))
    this.managerStateFile = path.join(this.dataDir, 'manager-state.json')
    this.sessions = new Map()
    this.registry = new TaskRegistry()
    this.clients = new Set()
    this.logger = createLogger()
    this.managerState = loadJsonFile(this.managerStateFile, {
      saved_at: null,
      sessionIds: []
    })
  }

  log(...args) {
    this.logger.log('[manager]', ...args)
  }

  addClient(wsClient) {
    this.clients.add(wsClient)
  }

  removeClient(wsClient) {
    this.clients.delete(wsClient)
  }

  broadcast(type, payload = {}) {
    const message = JSON.stringify({
      type,
      payload
    }, jsonSafeReplacer)
    for (const client of this.clients) {
      try {
        client.send(message)
      } catch {}
    }
  }

  createSession(config = {}) {
    const finalConfig = createDefaultSessionConfig(config)
    if (this.sessions.has(finalConfig.sessionId)) {
      throw new Error(`Session already exists: ${finalConfig.sessionId}`)
    }
    const session = new BotSession(this, finalConfig)
    session.on('event', event => this.emit('session_event', event))
    this.sessions.set(finalConfig.sessionId, session)
    this.saveSessionConfig(session)
    this.saveState()
    return session
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null
  }

  updateSession(sessionId, patch = {}) {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.config = createDefaultSessionConfig({
      ...session.config,
      ...patch,
      sessionId
    })
    this.saveSessionConfig(session)
    this.saveState()
    this.broadcast('manager_snapshot', this.getSnapshot())
    return session
  }

  deleteSession(sessionId) {
    const session = this.getSession(sessionId)
    if (!session) return false
    session.disconnect('deleted')
    this.sessions.delete(sessionId)
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    this.saveState()
    this.broadcast('manager_snapshot', this.getSnapshot())
    return true
  }

  saveSessionConfig(session) {
    saveJsonFile(path.join(this.sessionsDir, `${session.sessionId}.json`), session.config)
  }

  saveState() {
    this.managerState = {
      saved_at: new Date().toISOString(),
      sessionIds: Array.from(this.sessions.keys())
    }
    saveJsonFile(this.managerStateFile, this.managerState)
    return this.managerState
  }

  loadState() {
    const files = listJsonFiles(this.sessionsDir)
    for (const filePath of files) {
      const config = loadJsonFile(filePath, null)
      if (!config?.sessionId) continue
      if (this.sessions.has(config.sessionId)) continue
      const session = new BotSession(this, config)
      session.on('event', event => this.emit('session_event', event))
      this.sessions.set(config.sessionId, session)
    }
    return this.getSnapshot()
  }

  async autoConnect() {
    for (const session of this.sessions.values()) {
      if (session.config.autoConnect) {
        await session.connect()
      }
    }
  }

  getSnapshot() {
    return {
      saved_at: new Date().toISOString(),
      sessions: Array.from(this.sessions.values()).map(session => session.getSnapshot()),
      tasks: this.registry.list()
    }
  }

  registerTask(task) {
    return this.registry.register(task)
  }

  registerTasks(tasks) {
    for (const task of tasks) {
      this.registry.register(task)
    }
  }
}

function registerDefaultTasks(manager) {
  const files = [
    './01-spawner-purchase-test.js',
    './02-tpa-system-test.js',
    './03-spawn-command-test.js',
    './04-kill-command-test.js',
    './05-scoreboard-parser-test.js',
    './07-inventory-counter-test.js',
    './08-socket-hub-test.js'
  ]

  for (const file of files) {
    const task = require(file)
    manager.registerTask(task)
  }

  return manager.registry.list()
}

module.exports = {
  BedrockTaskHelper,
  BotManager,
  BotSession,
  TaskRegistry,
  cloneForPacket,
  createDefaultSessionConfig,
  createLogger,
  ensureDir,
  extractDisplayName,
  extractLore,
  getAuthCacheDir,
  getSummarySignature,
  inspect,
  isPlayerWindow,
  jsonSafeReplacer,
  listJsonFiles,
  loadJsonFile,
  makeAirItem,
  makeFullContainerName,
  makeStackRequestSlotInfo,
  nbtRoot,
  normalizeChat,
  registerDefaultTasks,
  safeGet,
  saveJsonFile,
  stripMcColorCodes,
  summarizeItem,
  translateWindowId
}
