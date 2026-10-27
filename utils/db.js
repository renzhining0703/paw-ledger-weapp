/**
 * 数据层：云数据库 CRUD + 本地缓存 + 弱网写队列（PRD 7.3）
 *
 * 设计要点：
 * - 读：内存缓存（60s TTL）→ 云端；云端失败时降级读 storage 快照（离线可用）
 * - 写：本地乐观更新（记录标 _sync: 'pending'）→ 云端成功后回写真实 _id；
 *       失败入重试队列（storage 持久化），冷启动 / onShow 时重试，角标「待同步」
 * - 只做「写失败入队重试」，不做冲突合并；同一条记录以最后写入为准
 * - 所有业务查询必须带 petId（expenses 支持 'all' 汇总口径），禁止全表查询
 *
 * 缓存一致性规则（踩坑沉淀，勿破坏）：
 * 1. 乐观插入必须「刷新」缓存条目的时间戳——否则 60s TTL 会跳过缓存直接回源，
 *    而云端写入还在途，读到旧数据后把乐观记录冲掉（用户看到「记了却不显示」）
 * 2. 花销记录同时存在于多个缓存键（petId_月 / all_月 / petId 全量）：
 *    乐观插入要扇出到所有已存在的键；失效一律整桶清空，不做单键失效
 * 3. 「读取期间发生失效」竞态：读取发起于失效前、完成于失效后，会把过期数据
 *    重新缓存成 fresh。用 invalidAt 时间戳守卫：fetch 完成时若期间有过失效，
 *    缓存标记为 t=0（下次读强制回源）
 */
const config = require('./config')
const track = require('./track')
const store = require('./store')

// 防御性初始化：页面模块可能在 App.onLaunch 之前加载，wx.cloud.init 幂等可重复调用
if (wx.cloud) {
  wx.cloud.init({ env: config.CLOUD_ENV || undefined, traceUser: true })
}
const db = wx.cloud.database()
const _ = db.command

/**
 * petData 云函数统一调用 helper（二期收口后所有宠物数据读写经此）
 * @returns {object} 云函数 result（已校验 errCode）
 */
async function callPetData(data) {
  const res = await wx.cloud.callFunction({ name: 'petData', data })
  if (!res || !res.result) throw new Error('云函数无响应')
  if (res.result.errCode) {
    const e = new Error(res.result.errMsg || ('errCode ' + res.result.errCode))
    e.errCode = res.result.errCode
    e.result = res.result
    throw e
  }
  return res.result
}

const CACHE_TTL = 60 * 1000
const QUEUE_KEY = 'tj_sync_queue'
const QUEUE_MAX = 50
const SYNC_AT_KEY = 'tj_last_sync_at'
const DEAD_KEY = 'tj_sync_dead'      // 反复失败、已移出主队列的操作（排查用）
const ERR_KEY = 'tj_last_sync_err'  // 最近一次同步失败的原因（我的页可见）
const DEAD_MAX = 20
const DEAD_AFTER = 5                 // 同一条操作失败这么多次就不再占用主队列

/** 只有记录类集合走写队列（pets / users / subTickets 直连云端，不入队） */
const VALID_COLS = { health: 1, weights: 1, daily: 1, expenses: 1 }

const memCache = {
  pets: null,
  users: null,
  subTickets: null,
  health: {},   // { [petId]: { t, d } }
  weights: {},
  daily: {},
  expenses: {}, // { [`${petId}_${ym}` | `all_${ym}` | petId]: { t, d } }
  posts: {}     // { [petId]: { t, d } } 图文/相册（同一份数据）
}

/** 各集合最近一次失效时间（读后失效竞态守卫） */
const invalidAt = {}

/* ================= 缓存基础 ================= */

function fresh(e) {
  return !!e && Date.now() - e.t < CACHE_TTL
}

function snapKey(col, key) {
  return `tj_snap_${col}_${key}`
}

function persistSnap(col, key, data) {
  try { wx.setStorageSync(snapKey(col, key), { t: Date.now(), d: data }) } catch (e) { /* 忽略 */ }
}

function readSnap(col, key) {
  try { return wx.getStorageSync(snapKey(col, key)) || null } catch (e) { return null }
}

/**
 * 读取完成时应写入的缓存时间戳：
 * 若读取在途期间发生过失效（说明结果可能已过期），标记 t=0 强制下次回源
 */
function cacheTs(col, startedAt) {
  return (invalidAt[col] || 0) > startedAt ? 0 : Date.now()
}

function invalidate(col) {
  invalidAt[col] = Date.now()
  if (col === 'pets' || col === 'users' || col === 'subTickets') { memCache[col] = null; return }
  // 花销存在多个键（各宠物各月 + all + 全量），单键失效极易漏；整桶清空
  memCache[col] = {}
}

function invalidateAll() {
  ;['pets', 'users', 'subTickets', 'health', 'weights', 'daily', 'expenses', 'posts'].forEach(invalidate)
}

/* ================= 待同步叠加层（乐观更新的兜底，勿删） =================
 *
 * 为什么需要：本地乐观更新只写进「已存在的缓存键」，而同一条花销会落在多个
 * 口径键上（p1_2026-10 / all_2026-10 / p1 全量）。记账页默认口径是 all，
 * 若该键此前没读过（或已过期回源），而云端 add 还在途（几百 ms），回源结果里
 * 就没有刚记的这笔 → 用户看到「记了却不显示」。
 *
 * 因此：任何一次「回源」都必须把重试队列里尚未落云端的变更叠加回结果集，
 * 队列是唯一事实源（本身持久化在 storage，冷启动后依然有效）。
 */

function matchScope(col, key, r) {
  if (col !== 'expenses') return r.petId === key
  const m = /^(.+)_(\d{4}-\d{2})$/.exec(key)
  const scope = m ? m[1] : key
  const ym = m ? m[2] : ''
  if (scope !== 'all' && r.petId !== scope) return false
  if (ym && String(r.date || '').slice(0, 7) !== ym) return false
  return true
}

/**
 * 缓存键 → 真实 petId
 * 花销的键是 `${petId}_${ym}` 或 `all_${ym}`（见 insertLocalExpense / matchScope），
 * 而云端 membership 校验只认裸 petId；`all_` 推断不出归属，返回 ''。
 * ⚠️ 写库/入队一律用本函数换算，别把缓存键当 petId 传给云函数（曾导致花销全部 403）
 */
function scopePetIdOf(col, key) {
  if (col !== 'expenses') return String(key == null ? '' : key)
  const k = String(key == null ? '' : key)
  const m = /^(.+)_(\d{4}-\d{2})$/.exec(k)
  const scope = m ? m[1] : k
  return scope === 'all' ? '' : scope
}

/** 队列操作的真实 petId：优先 data.petId，其次从缓存键推断 */
function opPetId(op) {
  if (!op || op.col !== 'expenses') return op && op.petId
  const direct = (op.data && op.data.petId) || ''
  if (direct) return direct
  const fromKey = scopePetIdOf('expenses', op.petId)
  return fromKey || op.petId
}

/** 把队列里未确认的 add / update / remove 叠加到回源结果上，并按日期重排 */
function applyPending(col, key, list) {
  let ops
  try { ops = getQueue().filter((o) => o.col === col) } catch (e) { return list }
  if (!ops.length) return list

  const adds = []
  const patches = {}
  const removes = {}
  ops.forEach((o) => {
    if (o.action === 'add') adds.push({ _id: o.localId, _sync: 'pending', ...o.data })
    else if (o.action === 'update') patches[o.docId] = o.data
    else if (o.action === 'remove') removes[o.docId] = true
  })

  let out = list.filter((r) => !removes[r._id])
  out = out.map((r) => (patches[r._id] ? { ...r, ...patches[r._id], _sync: 'pending' } : r))
  const seen = {}
  out.forEach((r) => { seen[r._id] = true })
  const insert = adds.filter((r) => !seen[r._id] && matchScope(col, key, r))
  if (!insert.length) return out
  out = out.concat(insert)
  // 与云端口径保持一致：按日期倒序（同日保持原相对顺序）
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
}

/* ================= 弱网写队列 ================= */

let opSeq = 0

/**
 * opId 必须全局唯一：opSeq 是内存计数器，冷启动后归零，
 * 历史队列里的数字 opId 会和新操作撞号 → 按 opId 出队时误删别人
 */
function nextOpId() {
  return `${Date.now()}_${++opSeq}`
}

function getQueue() {
  let q
  try { q = wx.getStorageSync(QUEUE_KEY) || [] } catch (e) { return [] }
  if (!Array.isArray(q) || !q.length) return []
  // 规范化：补 opId / 去重 / 剔除脏数据（老版本残留可能让队列永久卡死）
  const seen = {}
  let dirty = false
  const out = []
  q.forEach((o) => {
    if (!o || typeof o !== 'object') { dirty = true; return }
    if (typeof o.opId !== 'string' || seen[o.opId]) { o.opId = nextOpId(); dirty = true }
    seen[o.opId] = true
    // 老版本把花销缓存键（`${petId}_${ym}`）当 petId 入队 → 云端 403。
    // 读队列时顺手还原真实 petId，历史坏数据无需用户重记
    if (o.col === 'expenses' && typeof o.petId === 'string' && /_\d{4}-\d{2}$/.test(o.petId)) {
      const fixed = (o.data && o.data.petId) || scopePetIdOf('expenses', o.petId)
      if (fixed && fixed !== o.petId) { o.petId = fixed; dirty = true }
    }
    out.push(o)
  })
  if (dirty) setQueue(out)
  return out
}

function setQueue(q) {
  try { wx.setStorageSync(QUEUE_KEY, q.slice(-QUEUE_MAX)) } catch (e) { /* 忽略 */ }
}

/** 队列超限：丢弃最旧的「非关键」操作（add/update 可丢，remove 不丢） */
function enqueue(op) {
  const q = getQueue()
  op.opId = nextOpId()
  q.push(op)
  let drop = q.length - QUEUE_MAX
  if (drop > 0) {
    for (let i = 0; i < q.length && drop > 0; i++) {
      if (q[i].action !== 'remove') { q.splice(i, 1); i--; drop-- }
    }
    wx.showToast({ title: '网络异常，部分记录待同步', icon: 'none' })
  }
  setQueue(q)
  store.emit('syncChanged', { pending: q.length })
}

function pendingCount() {
  return getQueue().length
}

function lastSyncAt() {
  return wx.getStorageSync(SYNC_AT_KEY) || 0
}

/* ================= 同步失败原因（必须可见，否则用户只能干瞪眼） ================= */

let lastErrCache = null

function setLastErr(e, col) {
  const item = {
    code: e && e.errCode != null ? e.errCode : '',
    msg: String((e && (e.errMsg || e.message)) || '').slice(0, 160),
    col: col || '',
    at: Date.now()
  }
  lastErrCache = item
  try { wx.setStorageSync(ERR_KEY, item) } catch (err) { /* 忽略 */ }
  return item
}

function clearLastErr() {
  lastErrCache = null
  try { wx.removeStorageSync(ERR_KEY) } catch (e) { /* 忽略 */ }
}

function lastSyncError() {
  if (lastErrCache) return lastErrCache
  try { lastErrCache = wx.getStorageSync(ERR_KEY) || null } catch (e) { lastErrCache = null }
  return lastErrCache
}

/**
 * 永久性错误：再试一万次也不会成功（集合没建 / 没权限 / 数据非法 / 文档已被删）。
 * 这类错误不能靠重试解决，只能暴露出来让人去控制台处理。
 */
function isFatal(e) {
  const code = e && e.errCode
  if (code === -502005 || code === -502003) return true   // 集合不存在 / 权限不足
  const msg = String((e && (e.errMsg || e.message)) || '')
  // duplicate key（E11000）：同一个键再插一万次也是冲突，重试毫无意义，只能人工处理
  return /collection not exists|permission denied|document.*not exist|invalid|duplicate key|E11000/i.test(msg)
}

/** 出队：按 opId 精确移除（不能回写启动时的副本，会覆盖期间新入队的操作） */
function removeOpById(opId) {
  const q = getQueue()
  const at = q.findIndex((o) => o.opId === opId)
  if (at > -1) { q.splice(at, 1); setQueue(q); return true }
  return false
}

/** 失败的操作沉到队尾，让后面的操作还有机会成功（旧实现在这里 break，一条坏数据堵死整条队列） */
function rotateOp(op) {
  const q = getQueue()
  const at = q.findIndex((o) => o.opId === op.opId)
  if (at > -1) { q.splice(at, 1); q.push(op) }
  setQueue(q)
}

/** 反复失败的操作移出主队列，避免占着 50 条上限把新记录挤掉 */
function deadOp(op) {
  const q = getQueue()
  const at = q.findIndex((o) => o.opId === op.opId)
  if (at > -1) q.splice(at, 1)
  setQueue(q)
  let dead = []
  try { dead = wx.getStorageSync(DEAD_KEY) || [] } catch (e) { dead = [] }
  dead.push({ ...op, deadAt: Date.now() })
  try { wx.setStorageSync(DEAD_KEY, dead.slice(-DEAD_MAX)) } catch (e) { /* 忽略 */ }
}

function deadList() {
  try { return wx.getStorageSync(DEAD_KEY) || [] } catch (e) { return [] }
}

function clearDead() {
  try { wx.removeStorageSync(DEAD_KEY) } catch (e) { /* 忽略 */ }
}

/**
 * 修好云端（建集合 / 改权限）后，把已放弃的操作放回队列重来一次。
 * 没有这个口子，用户就算把环境修好了，这些记录也永远不会再同步。
 */
function retryDead() {
  const dead = deadList()
  if (!dead.length) return 0
  clearDead()
  dead.forEach((o) => {
    enqueue({ action: o.action, col: o.col, petId: o.petId, localId: o.localId, docId: o.docId, data: o.data })
  })
  return dead.length
}

/**
 * 死信区里的「花销 403」是旧 bug（缓存键当 petId 入队）造成的，
 * 代码修好后这些记录其实能写成功。每次冷启动悄悄放回队列重试一次，
 * 不需要用户去诊断页手动点重试、更不用重记。
 */
let healedFixable = false
function retryFixableDead() {
  if (healedFixable) return 0
  healedFixable = true
  const dead = deadList()
  if (!dead.length) return 0
  const keep = []
  const back = []
  dead.forEach((o) => {
    const code = String(o.errCode == null ? '' : o.errCode)
    const fixable = o.col === 'expenses' && code === '403'
    if (fixable) back.push(o)
    else keep.push(o)
  })
  if (!back.length) return 0
  try { wx.setStorageSync(DEAD_KEY, keep) } catch (e) { /* 忽略 */ }
  back.forEach((o) => {
    enqueue({ action: o.action, col: o.col, petId: o.petId, localId: o.localId, docId: o.docId, data: o.data })
  })
  if (config.DEBUG) console.warn('[db] 死信区花销 403 记录已放回队列重试', back.length)
  return back.length
}

/* ================= 重试队列 ================= */

let flushing = false
/** 本会话已自动创建过的集合（避免每次 flush 都重试建表） */
const autoCreated = {}

/**
 * 重试队列：冷启动 / 页面 onShow / 手动点击调用；串行执行保持写入顺序
 *
 * ⚠️ 不要持有队列副本循环：处理一个 op 往往要 await 几百毫秒，期间页面可能又
 * enqueue 了新操作（例如「先记健康再记关联花销」）；若用启动时的副本回写
 * setQueue，会把这些新操作整个覆盖掉，写请求凭空消失。
 * 正确做法：每次循环重新读队列，完成后按 opId 精确移除队首。
 *
 * ⚠️ 失败不能 break：队列里第一条若是「集合没建」这类永久性错误，后面属于
 * 其它集合的操作会被永久堵死（用户看到的就是「从来没同步成功过」）。
 * 现在改为「每条本轮最多试一次，失败沉到队尾」，并把失败原因存下来给人看。
 */
async function execOp(op) {
  // 花销的历史队列里可能存着缓存键（`${petId}_${ym}`），换算成真实 petId 再发请求，
  // 否则云端 membership 校验必然 403（老队列也能靠这里自愈，不需要用户重记）
  const petId = opPetId(op)
  if (op.action === 'add') {
    const r = await callPetData({ action: 'addRecord', col: op.col, petId, data: op.data })
    const realId = r && r._id
    if (realId) {
      fixRefs(op.localId, realId)
      // 回写真实 _id（花销可能存在于多个缓存键，逐一替换）
      const entries = op.col === 'expenses'
        ? Object.keys(memCache.expenses).map((k) => [k, memCache.expenses[k]])
        : (memCache[op.col][op.petId] ? [[op.petId, memCache[op.col][op.petId]]] : [])
      entries.forEach(([k, e]) => {
        const i = e.d.findIndex((x) => x._id === op.localId)
        if (i > -1) {
          const rec = { ...e.d[i], _id: realId }
          delete rec._sync
          e.d[i] = rec
          persistSnap(op.col, k, e.d)
        }
      })
    }
    return realId
  }
  if (op.action === 'update') {
    await callPetData({ action: 'updateRecord', col: op.col, petId, id: op.docId, data: op.data })
    return true
  }
  if (op.action === 'remove') {
    await callPetData({ action: 'removeRecord', col: op.col, petId, id: op.docId })
    return true
  }
  throw new Error('未知的队列操作：' + op.action)
}

async function flushSync() {
  if (flushing) return { skipped: true }
  retryFixableDead()
  if (!getQueue().length) return { done: 0, remain: 0 }
  flushing = true
  let done = 0
  try {
    // 每条操作本轮最多尝试一次：转回来第二次就收工，不会原地空转。
    // ⚠️ 不能用「启动时队列长度」当次数上限——处理一个 op 要 await 几百毫秒，
    // 期间页面可能又入队了新操作（记健康 → 紧接着记关联花销），
    // 用快照会把这些新操作晾到下一轮。这里按 opId 去重，新操作照样本轮处理。
    const tried = {}
    let guard = 0
    for (;;) {
      const op = getQueue()[0]
      if (!op) break
      if (tried[op.opId]) break
      if (++guard > 200) break
      tried[op.opId] = 1
      // 脏数据守卫：集合名不在白名单 / 缺 action → 永远写不进去，直接丢弃
      if (!op.action || !VALID_COLS[op.col]) { removeOpById(op.opId); continue }
      try {
        await execOp(op)
        // 顺序要紧：先出队、再失效缓存。反过来的话，并发的读会同时看到
        // 「已落库的云端真值」和「队列里还没移除的同一条 add」→ 重复两条
        removeOpById(op.opId)
        done++
        invalidate(op.col)
        store.markDirty()   // 云端真值已到达，各页面下次 onShow 应看到它
      } catch (e) {
        // 最高频的坑：云开发不会自动建表，客户端写入不存在的集合一律 -502005。
        // 自愈一次：建好集合立刻重试，能救就救；救不回来再把原因摆给用户
        if (e && e.errCode === -502005 && !autoCreated[op.col] && typeof db.createCollection === 'function') {
          autoCreated[op.col] = 1
          try {
            await db.createCollection(op.col)
            await execOp(op)
            removeOpById(op.opId)
            done++
            invalidate(op.col)
            store.markDirty()
            continue
          } catch (e2) { /* 建表失败 → 落到下面的正常失败处理，把原因暴露出来 */ }
        }
        const err = setLastErr(e, op.col)
        const fatal = isFatal(e)
        if (config.DEBUG) console.warn('[db] 同步失败', op.col, op.action, 'errCode=' + err.code, err.msg)
        track.track('sync_failed', { collection: op.col, errCode: err.code, fatal }, false)
        op.fails = (op.fails || 0) + 1
        op.errCode = err.code
        if (fatal || op.fails >= DEAD_AFTER) deadOp(op)
        else rotateOp(op)
      }
    }
    if (done) {
      wx.setStorageSync(SYNC_AT_KEY, Date.now())
      store.emit('syncChanged', { pending: getQueue().length })
    }
    // 只有「队列空 且 没有已放弃的记录」才算真的同步干净了；
    // 否则错误原因必须留着——否则用户看到「12 条待同步」一闪变成「已同步」，
    // 记录却永远没上云端，连原因都查不到
    if (!getQueue().length && !deadList().length) clearLastErr()
  } finally {
    flushing = false
  }
  return { done, remain: getQueue().length, err: done ? null : lastSyncError() }
}

/**
 * 同步自检：探活 petData 云函数 + 个人私有集合。
 * 收口后五集合转管理端，前端无法直查；探活改为调 listPets（验云函数与 membership 链路）。
 */
async function diagnose() {
  const out = []
  // 验证 petData 云函数与 pets 链路（调用一次 listPets 即可覆盖）
  try {
    await callPetData({ action: 'listPets' })
    out.push({ col: 'petData(pets/health/weights/daily/expenses)', ok: true })
  } catch (e) {
    out.push({
      col: 'petData',
      ok: false,
      errCode: e && e.errCode != null ? e.errCode : '',
      errMsg: String((e && (e.errMsg || e.message)) || '').slice(0, 60)
    })
  }
  // 个人私有集合（users / subTickets）仍是「仅创建者可读写」，直查可探活
  for (const c of ['users', 'subTickets']) {
    try {
      await db.collection(c).limit(1).get()
      out.push({ col: c, ok: true })
    } catch (e) {
      out.push({
        col: c,
        ok: false,
        errCode: e && e.errCode != null ? e.errCode : '',
        errMsg: String((e && (e.errMsg || e.message)) || '').slice(0, 60)
      })
    }
  }
  return out
}

/* ================= 通用写：乐观更新 + 失败入队 ================= */

let localIdSeq = Date.now()
function genLocalId() {
  return `local_${localIdSeq++}_${Math.floor(Math.random() * 1e4)}`
}

/** 乐观插入单键缓存（刷新时间戳，保证 60s TTL 内的即时回读能命中） */
function insertLocal(col, key, record) {
  const e = memCache[col][key] || (memCache[col][key] = { t: 0, d: [] })
  e.d = [record, ...e.d]
  e.t = Date.now()
  persistSnap(col, key, e.d)
}

/**
 * 花销乐观插入扇出：同一条记录存在于多个缓存键
 * - `${petId}_${ym}`（首页 / 单宠月账）· `all_${ym}`（记账页全部口径）· `petId`（全量统计）
 * 已存在的键就地插入并刷新；至少保证 `${petId}_${ym}` 存在（首页立即可见）
 */
function insertLocalExpense(petId, record) {
  const ym = (record.date || '').slice(0, 7)
  const keys = [`${petId}_${ym}`, `all_${ym}`, petId]
  keys.forEach((k) => {
    const e = memCache.expenses[k]
    if (e) {
      e.d = [record, ...e.d]
      e.t = Date.now()
      persistSnap('expenses', k, e.d)
    }
  })
  if (!memCache.expenses[`${petId}_${ym}`]) {
    memCache.expenses[`${petId}_${ym}`] = { t: Date.now(), d: [record] }
    persistSnap('expenses', `${petId}_${ym}`, [record])
  }
}

/** 花销本地修改扇出（所有缓存键中命中 _id 的都打补丁） */
function patchLocalExpense(id, data) {
  Object.keys(memCache.expenses).forEach((k) => {
    const e = memCache.expenses[k]
    const i = e.d.findIndex((r) => r._id === id)
    if (i > -1) {
      e.d[i] = { ...e.d[i], ...data }
      e.t = Date.now()
      persistSnap('expenses', k, e.d)
    }
  })
}

/** 花销本地删除扇出 */
function removeLocalExpense(id) {
  Object.keys(memCache.expenses).forEach((k) => {
    const e = memCache.expenses[k]
    const i = e.d.findIndex((r) => r._id === id)
    if (i > -1) {
      e.d = e.d.filter((r) => r._id !== id)
      e.t = Date.now()
      persistSnap('expenses', k, e.d)
    }
  })
}

function patchLocal(col, key, id, data) {
  const e = memCache[col][key]
  if (!e) return
  const i = e.d.findIndex((r) => r._id === id)
  if (i > -1) {
    e.d[i] = { ...e.d[i], ...data }
    e.t = Date.now()
    persistSnap(col, key, e.d)
  }
}

function removeLocal(col, key, id) {
  const e = memCache[col][key]
  if (!e) return
  e.d = e.d.filter((r) => r._id !== id)
  e.t = Date.now()
  persistSnap(col, key, e.d)
}

/** 队列里已存在的同本地 add 操作原地合并（避免 add+update 拆两条） */
function mergeQueuedAdd(col, localId, data) {
  const q = getQueue()
  const op = q.find((o) => o.action === 'add' && o.col === col && o.localId === localId)
  if (op) {
    op.data = { ...op.data, ...data }
    setQueue(q)
    return true
  }
  return false
}

/**
 * 新增记录
 * ⚠️ 集合一律按 petId 查询，写入必须带 petId；表单 payload 里未必有（如健康/体重），
 *    这里统一从 key 推断补齐，否则云端记录查不出来（记完就消失）
 */
async function addRecord(col, key, data) {
  const localId = genLocalId()
  const app = getApp()
  const openid = (app && app.globalData && app.globalData.openid) || ''
  // 花销的 key 是缓存键（`${petId}_${ym}`），真实 petId 必须换算出来，
  // 否则入队的 petId 是缓存键，云端 membership 校验 403（花销全部同步失败）
  const scopePetId = scopePetIdOf(col, key)
  const body = { ...data, petId: data.petId || scopePetId, createdBy: openid }
  const local = { _id: localId, _sync: 'pending', ...body }
  if (col === 'expenses') {
    insertLocalExpense(body.petId, local)
  } else {
    insertLocal(col, key, local)
  }
  enqueue({ action: 'add', col, petId: body.petId, localId, data: body })
  store.markDirty()
  flushSync()
  return local
}

/**
 * 本地 id 换成云端真 id 后，修正其它集合里指向它的引用。
 *
 * 典型场景：先记健康记录（本地 id local_xxx），紧接着为它记一笔关联花销，
 * 花销里的 sourceId 写的还是 local_xxx。串行提交保证健康记录先落地，
 * 此时花销还在队列中，把队列里的 sourceId 改成真 id 即可，无需额外请求。
 */
function fixRefs(localId, realId) {
  if (!localId || !realId || localId === realId) return
  Object.keys(memCache.expenses).forEach((k) => {
    const e = memCache.expenses[k]
    let hit = false
    e.d = e.d.map((r) => {
      if (r.sourceId !== localId) return r
      hit = true
      return { ...r, sourceId: realId }
    })
    if (hit) persistSnap('expenses', k, e.d)
  })
  const q = getQueue()
  let changed = false
  q.forEach((o) => {
    if (o.action === 'add' && o.col === 'expenses' && o.data && o.data.sourceId === localId) {
      o.data.sourceId = realId
      changed = true
    }
  })
  if (changed) setQueue(q)
}

/** remove/update 遇到 `all_` 键推断不出归属时，按 _id 到缓存里找真实 petId */
function findPetIdInCache(col, id) {
  const buckets = memCache[col] || {}
  const keys = Object.keys(buckets)
  for (let i = 0; i < keys.length; i++) {
    const e = buckets[keys[i]]
    const hit = (e && e.d || []).find((r) => r._id === id)
    if (hit && hit.petId) return hit.petId
  }
  return ''
}

async function updateRecord(col, key, id, data) {
  if (col === 'expenses') {
    patchLocalExpense(id, { ...data, _sync: 'pending' })
  } else {
    patchLocal(col, key, id, { ...data, _sync: 'pending' })
  }
  if (String(id).indexOf('local_') === 0) {
    mergeQueuedAdd(col, id, data)
    flushSync()
    return
  }
  // 入队一律写真实 petId（花销的 key 是缓存键，不能直接当 petId 传给云函数）
  const petId = (data && data.petId) || scopePetIdOf(col, key) || findPetIdInCache(col, id) || key
  enqueue({ action: 'update', col, petId, docId: id, data })
  store.markDirty()
  flushSync()
}

async function removeRecord(col, key, id) {
  if (col === 'expenses') {
    removeLocalExpense(id)
  } else {
    removeLocal(col, key, id)
  }
  if (String(id).indexOf('local_') === 0) {
    // 未落云端的本地记录：直接丢弃队列里的 add
    setQueue(getQueue().filter((o) => !(o.action === 'add' && o.col === col && o.localId === id)))
    return
  }
  const petId = scopePetIdOf(col, key) || findPetIdInCache(col, id) || key
  enqueue({ action: 'remove', col, petId, docId: id })
  store.markDirty()
  flushSync()
}

/* ================= pets ================= */

async function listPets(force) {
  if (!force && fresh(memCache.pets)) return memCache.pets.d
  const t0 = Date.now()
  try {
    const r = await callPetData({ action: 'listPets' })
    memCache.pets = { t: cacheTs('pets', t0), d: r.data }
    persistSnap('pets', 'all', r.data)
    return r.data
  } catch (e) {
    const snap = readSnap('pets', 'all')
    if (snap) { memCache.pets = { t: Date.now(), d: snap.d }; return snap.d }
    throw e
  }
}

async function addPet(data) {
  const r = await callPetData({ action: 'addPet', data })
  invalidate('pets')
  return { _id: r._id }
}

async function updatePet(id, data) {
  await callPetData({ action: 'updatePet', petId: id, data })
  invalidate('pets')
  return { errCode: 0 }
}

/** 删除宠物：走云函数 petRemove 事务性级联删除其下全部记录（PRD 7.1） */
async function removePet(petId) {
  const r = await wx.cloud.callFunction({ name: 'petRemove', data: { petId } })
  invalidateAll()
  return r
}

/* ================= 共享成员关系（二期） ================= */

async function listMembers(petId) {
  return callPetData({ action: 'listMembers', petId })
}

async function createInvite(petId) {
  return callPetData({ action: 'createInvite', petId })
}

async function previewInvite(inviteId) {
  return callPetData({ action: 'previewInvite', inviteId })
}

async function acceptInvite(inviteId) {
  return callPetData({ action: 'acceptInvite', inviteId })
}

async function revokeInvite(inviteId) {
  return callPetData({ action: 'revokeInvite', inviteId })
}

async function listPendingInvites(petId) {
  return callPetData({ action: 'listPendingInvites', petId })
}

/** 给待接受邀请写备注（区分「这条发给谁」）；传空字符串可清除 */
async function updateInviteLabel(inviteId, label) {
  return callPetData({ action: 'updateInviteLabel', inviteId, label })
}

async function removeMember(petId, targetOpenid) {
  return callPetData({ action: 'removeMember', petId, targetOpenid })
}

async function quitMember(petId) {
  return callPetData({ action: 'quitMember', petId })
}

async function updateNotify(petId, notify) {
  return callPetData({ action: 'updateNotify', petId, notify })
}

/** 「我的」页保存昵称头像后调用：把最新资料刷进所有共享成员记录快照 */
async function syncMyProfile() {
  return callPetData({ action: 'syncMyProfile' })
}

/* ================= 健康 / 体重 / 日常 / 花销 ================= */

async function listBy(col, petId, opts) {
  const opts_ = opts || {}
  const cacheKey = petId
  if (!opts_.force && fresh(memCache[col][cacheKey])) return memCache[col][cacheKey].d
  const t0 = Date.now()
  try {
    const r = await callPetData({ action: 'listBy', col, petId })
    r.data.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    // 回源结果缺「云端还在途」的本地变更，必须叠加，否则用户刚记的会凭空消失
    const data = applyPending(col, cacheKey, r.data)
    memCache[col][cacheKey] = { t: cacheTs(col, t0), d: data }
    persistSnap(col, cacheKey, data)
    return data
  } catch (e) {
    const snap = readSnap(col, cacheKey)
    if (snap) { memCache[col][cacheKey] = { t: Date.now(), d: snap.d }; return snap.d }
    throw e
  }
}

/**
 * 花销按月查询（支持 petId = 'all' 汇总口径）
 * @param {string} petIdOrAll 宠物 id 或 'all'
 * @param {string} ym 'YYYY-MM'
 */
async function listExpensesMonth(petIdOrAll, ym, force) {
  const key = `${petIdOrAll}_${ym}`
  if (!force && fresh(memCache.expenses[key])) return memCache.expenses[key].d
  const t0 = Date.now()
  const start = ym + '-01'
  const end = require('./util').monthOffset(ym, 1) + '-01'
  try {
    const r = await callPetData({ action: 'listExpensesMonth', petIdOrAll, start, end })
    // 同上：叠加未落云端的本地变更（记账页 all 口径最容易踩到）
    const data = applyPending('expenses', key, r.data)
    memCache.expenses[key] = { t: cacheTs('expenses', t0), d: data }
    persistSnap('expenses', key, data)
    return data
  } catch (e) {
    const snap = readSnap('expenses', key)
    if (snap) { memCache.expenses[key] = { t: Date.now(), d: snap.d }; return snap.d }
    throw e
  }
}

/* ================= 图文 / 相册（PRD v2.1） =================
 *
 * ⚠️ posts **故意不进** VALID_COLS 与离线写队列：
 *    图片必须先上传拿 fileID，断网时这一步做不到，入队只会得到「有文案没图」的残记录，
 *    还会占用 50 条上限把其它记录的同步挤掉。弱网续传由 post-sheet 自己的待上传列表负责。
 * ⚠️ 可见范围（visibility）完全由云端过滤，前端拿到的就是「我可见」的集合，
 *    不要在页面里再自己筛一遍（否则「共享可见」的老数据缺字段会被误判成私密）。
 */

async function listPosts(petId, opts) {
  const o = opts || {}
  const key = String(petId || '')
  if (!key) return []
  if (!o.force && fresh(memCache.posts[key])) return memCache.posts[key].d
  const t0 = Date.now()
  try {
    const r = await callPetData({ action: 'listPosts', petId: key })
    // 空结果时云函数会附带诊断（该 petId 下实际有多少条），直接打到前端控制台便于对比
    if (r && r.diag) console.error('[db] listPosts 空结果诊断', JSON.stringify(r.diag))
    const data = (r.data || []).slice()
    memCache.posts[key] = { t: cacheTs('posts', t0), d: data }
    persistSnap('posts', key, data)
    return data
  } catch (e) {
    const snap = readSnap('posts', key)
    if (snap) { memCache.posts[key] = { t: Date.now(), d: snap.d }; return snap.d }
    throw e
  }
}

async function addPost(petId, data) {
  const r = await callPetData({ action: 'addPost', petId, data })
  invalidate('posts')
  store.markDirty()
  return r
}

async function removePost(petId, id) {
  const r = await callPetData({ action: 'removePost', petId, id })
  invalidate('posts')
  store.markDirty()
  return r
}

/** 文案内容安全检测（P0 同步）。返回 { pass, unchecked, suggest } */
async function checkText(text) {
  return callPetData({ action: 'checkText', text })
}

/* ================= 风控：举报 / 申诉（PRD《内容安全与风控》） ================= */

/**
 * 举报一条图文
 * @returns {{takenDown:boolean, reporters:number, duplicated?:boolean}}
 *   takenDown=false 不代表没记上：只是还没到下架阈值（2 人 / owner）
 */
async function reportPost(petId, id, reason) {
  const r = await callPetData({ action: 'reportPost', petId, id, reason })
  invalidate('posts')
  store.markDirty()
  return r
}

/** 申诉「我认为这是误判」 */
async function appealPost(petId, id, note) {
  const r = await callPetData({ action: 'appealPost', petId, id, note })
  invalidate('posts')
  store.markDirty()
  return r
}

/**
 * 运营后台（csAdmin）调用
 * ⚠️ 服务端还会再校验一次 openid 白名单 + 口令；前端隐藏入口只是「好看」，不是安全边界
 */
async function admin(action, extra) {
  const r = await wx.cloud.callFunction({
    name: 'csAdmin',
    data: Object.assign({ action }, extra || {})
  })
  return (r && r.result) || {}
}

/* ================= users（可选头像昵称设置） ================= */

async function getMySettings(force) {
  if (!force && fresh(memCache.users)) return memCache.users.d
  try {
    const r = await db.collection('users').limit(1).get()
    memCache.users = { t: Date.now(), d: r.data[0] || null }
    return memCache.users.d
  } catch (e) {
    return memCache.users ? memCache.users.d : null
  }
}

async function saveMySettings(partial) {
  const u = await getMySettings()
  store.setUser(partial)
  if (!u) {
    const r = await db.collection('users').add({
      data: { settings: partial, createdAt: db.serverDate(), lastActiveAt: db.serverDate() }
    })
    invalidate('users')
    return r
  }
  const r = await db.collection('users').doc(u._id).update({
    data: { settings: { ...(u.settings || {}), ...partial }, lastActiveAt: db.serverDate() }
  })
  invalidate('users')
  return r
}

/* ================= subTickets（授权余额） ================= */

async function getSubBalance(force) {
  if (!force && fresh(memCache.subTickets)) return memCache.subTickets.d
  try {
    // ⚠️ 必须按「当前模板」过滤：换过模板后库里会同时存在新旧两条 ticket，
    //    裸 limit(1) 取到哪条全看数据库顺序 → 大概率取到旧模板那条（余额 0），
    //    表现就是「明明授权成功了，我的页却显示 0 次」。与 remind 云函数的校验口径保持一致。
    const r = await db.collection('subTickets')
      .where({ tmplId: config.SUBSCRIBE_TEMPLATE_ID })
      .limit(1)
      .get()
      .catch(() => null)
    // 按模板查不到就退回裸查（兼容历史数据没有 tmplId 字段的情况）
    const r2 = (r && r.data && r.data.length) ? r : await db.collection('subTickets').limit(1).get().catch(() => ({ data: [] }))
    const doc = (r2 && r2.data && r2.data[0]) || null
    memCache.subTickets = { t: Date.now(), d: doc ? doc.balance : 0 }
    return memCache.subTickets.d
  } catch (e) {
    return memCache.subTickets ? memCache.subTickets.d : 0
  }
}

/** 授权成功后余额 +1（走云函数，前端 storage 不可信） */
async function incrSubBalance(tmplId) {
  const r = await wx.cloud.callFunction({ name: 'subscribe', data: { tmplId: tmplId || config.SUBSCRIBE_TEMPLATE_ID } })
  invalidate('subTickets')
  const bal = r.result && r.result.balance
  if (typeof bal === 'number') {
    memCache.subTickets = { t: Date.now(), d: bal }
    store.emit('subChanged', bal)
  }
  return bal
}

/**
 * 冷启动同步读取「上次进入选中的宠物昵称」：
 * 本地 pets 快照 + store.currentPetId（不发起网络请求，供启动页文案用）
 * 取不到（首次使用 / 无快照）返回 ''，调用方回退到通用文案
 */
function lastPetName() {
  try {
    const snap = readSnap('pets', 'all')
    const list = (snap && snap.d) || []
    if (!list.length) return ''
    const id = store.state.currentPetId
    const hit = list.find((p) => p._id === id) || list[0]
    return (hit && hit.name) || ''
  } catch (e) {
    return ''
  }
}

module.exports = {
  flushSync,
  pendingCount,
  lastSyncAt,
  lastSyncError,
  diagnose,
  deadList,
  clearDead,
  retryDead,
  invalidateAll,
  listPets,
  addPet,
  updatePet,
  removePet,
  listBy,
  addRecord,
  updateRecord,
  removeRecord,
  listExpensesMonth,
  listPosts,
  addPost,
  removePost,
  checkText,
  reportPost,
  appealPost,
  admin,
  getMySettings,
  saveMySettings,
  getSubBalance,
  incrSubBalance,
  lastPetName,
  listMembers,
  createInvite,
  previewInvite,
  acceptInvite,
  revokeInvite,
  listPendingInvites,
  updateInviteLabel,
  removeMember,
  quitMember,
  updateNotify,
  syncMyProfile
}
