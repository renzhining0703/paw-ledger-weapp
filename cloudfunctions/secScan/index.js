/**
 * secScan · 内容安全定时巡检（PRD《内容安全与风控》第 8 节）
 *
 * ⚠️ 云函数之间无法共享代码文件，本文件里的检测逻辑是 petData/sec.js 的**副本**。
 *    改了 petData/sec.js 的检测逻辑，记得同步这里（已踩：两处 FAQ 不同步）。
 *
 * 每 30 分钟（triggers 见 config.json）：
 *   ① 扫 posts 里 audit ∈ {pending, unchecked} 的最多 20 条，重跑一次检测
 *      - 命中 87014 → audit='blocked' + visibility='private'（先下架，保留申诉期）
 *      - 通过     → audit='ok'
 *      - 仍不可用 → auditTries+1；累计 3 次就收敛成 'ok'（别无限重复扫同一批）
 *      ⚠️ unchecked（发布时云调用+HTTPS 两级全挂）也在捞的范围内：
 *         只扫 pending 的话，检测服务恢复后那批内容会永远停在 unchecked 没人复检
 *   ② blocked 满 7 天（申诉期过）→ 删掉 full 原图，只留 thumb
 *      ⚠️ 对应红线第 6 条：不许长期留存违规原图，否则我们自己变成「存储违规内容」的一方
 *   ③ 清 30 天前的 rateLimit 计数（不然这个集合只增不减）
 *
 * ⚠️ 定时触发器是**北京时间**，但云函数里 new Date() 是 UTC —— 取「今天」必须 +8h（已踩）
 */
const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const BUILD = '20261026-a2'

const SCAN_LIMIT = 20
/** 连续多少次仍检测不了就放弃（置 ok），避免同一批永远占着巡检额度 */
const AUDIT_MAX_TRIES = 3
const BLOCKED_KEEP_MS = 7 * 24 * 3600 * 1000
const RATE_KEEP_DAYS = 30
/** 与 petData/sec.js 保持一致：实战 >100KB 就常报「图片太大」 */
const IMG_MAX_BYTES = 100 * 1024

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex')
}

function httpsJson(url, method, body) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { reject(e); return }
    const payload = body ? JSON.stringify(body) : ''
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method || 'GET',
      timeout: 8000,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {}
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('返回非 JSON: ' + buf.slice(0, 120))) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function httpsMultipart(url, name, filename, buf) {
  const BOUND = '----pawsec' + Math.random().toString(36).slice(2, 10)
  const head = Buffer.from(
    `--${BOUND}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    'Content-Type: image/jpeg\r\n\r\n'
  )
  const tail = Buffer.from(`\r\n--${BOUND}--\r\n`)
  const body = Buffer.concat([head, buf, tail])
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { reject(e); return }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 15000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUND}`, 'Content-Length': body.length }
    }, (res) => {
      let s = ''
      res.on('data', (c) => { s += c })
      res.on('end', () => {
        try { resolve(JSON.parse(s)) } catch (e) { reject(new Error('返回非 JSON: ' + s.slice(0, 120))) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

let _token = null
let _tokenAt = 0

async function accessToken() {
  if (_token && Date.now() - _tokenAt < 100 * 60 * 1000) return _token
  const ctx = cloud.getWXContext() || {}
  // ⚠️ 定时触发器里 getWXContext() 拿不到 APPID → 必须靠环境变量 MINI_APPID 兜底
  const appid = String(process.env.MINI_APPID || ctx.APPID || '').trim()
  const secret = String(process.env.MINI_APPSECRET || '').trim()
  if (!appid || !secret) throw new Error('NOCFG')
  const r = await httpsJson(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`)
  if (!r || !r.access_token) throw new Error('换 token 失败: ' + JSON.stringify(r))
  _token = r.access_token
  _tokenAt = Date.now()
  return _token
}

/** @returns {'pass'|'reject'|'error'} */
async function checkText(openid, text) {
  const t = String(text || '').trim()
  if (!t) return 'pass'
  try {
    const r = await cloud.openapi.security.msgSecCheck({ content: t, version: 2, scene: 2, openid })
    if (r && r.errCode === 0) return ((r.result && r.result.suggest) === 'risky') ? 'reject' : 'pass'
  } catch (e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.errcode)
    if (code === 87014) return 'reject'
  }
  try {
    const at = await accessToken()
    const r2 = await httpsJson('https://api.weixin.qq.com/wxa/msg_sec_check?access_token=' + at, 'POST',
      { content: t, version: 2, scene: 2, openid })
    if (r2 && r2.errcode === 87014) return 'reject'
    if (r2 && r2.errcode === 0) return 'pass'
    return 'error'
  } catch (e) {
    return 'error'
  }
}

async function isWhitelisted(hash) {
  if (!hash) return false
  try {
    const r = await db.collection('auditWhitelist').where({ key: hash }).limit(1).get()
    return !!(r.data && r.data.length)
  } catch (e) {
    return false
  }
}

/** @returns {'ok'|'reject'|'error'} */
async function checkImgBuffer(buf) {
  try {
    const r = await cloud.openapi.security.imgSecCheck({ media: { contentType: 'image/jpeg', value: buf } })
    if (r && (r.errCode === 87014 || r.errcode === 87014)) return 'reject'
    return 'ok'
  } catch (e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.errcode)
    if (code === 87014) return 'reject'
  }
  try {
    const at = await accessToken()
    const r2 = await httpsMultipart('https://api.weixin.qq.com/wxa/img_sec_check?access_token=' + at,
      'media', 'a.jpg', buf)
    if (r2 && r2.errcode === 87014) return 'reject'
    if (r2 && r2.errcode === 0) return 'ok'
    return 'error'
  } catch (e) {
    return 'error'
  }
}

async function deleteFiles(fileIDs) {
  const list = (fileIDs || []).filter(Boolean)
  if (!list.length) return 0
  let n = 0
  for (let i = 0; i < list.length; i += 50) {
    try {
      await cloud.deleteFile({ fileList: list.slice(i, i + 50) })
      n += Math.min(50, list.length - i)
    } catch (e) {
      console.error('[secScan] deleteFile 失败', e && e.message)
    }
  }
  return n
}

/**
 * 重检一条 post
 * @returns {{verdict:'reject'|'ok'|'pending', target:string}}
 */
async function scanPost(p) {
  const openid = p.createdBy || p._openid || ''
  let target = ''

  if (p.content) {
    const t = await checkText(openid, p.content)
    if (t === 'reject') return { verdict: 'reject', target: 'text' }
    if (t === 'error') target = 'text'
  }

  const images = (p.images || []).map((im) => im && (im.thumbID || im.fileID)).filter(Boolean)
  for (const fileID of images) {
    let buf
    try {
      const r = await cloud.downloadFile({ fileID })
      buf = r && r.fileContent
    } catch (e) {
      target = target || 'image'
      continue
    }
    if (!buf || !buf.length || buf.length > IMG_MAX_BYTES) { target = target || 'image'; continue }
    const hash = md5(buf)
    if (await isWhitelisted(hash)) continue
    const v = await checkImgBuffer(buf)
    if (v === 'reject') return { verdict: 'reject', target: 'image' }
    if (v === 'error') target = target || 'image'
  }

  return target ? { verdict: 'pending', target } : { verdict: 'ok', target: '' }
}

/** ① 补检 pending / unchecked
 * ⚠️ unchecked（发布时两级检测全挂）必须一起捞：只扫 pending 的话，
 *    检测服务恢复后那批内容会永远停在 unchecked，没人复检。
 * ⚠️ 用 _.in，不要往 $or 里塞查询指令（实测一条都匹配不上，已踩） */
async function scanPending() {
  const r = await db.collection('posts')
    .where({ audit: _.in(['pending', 'unchecked']) })
    .orderBy('auditAt', 'asc')
    .limit(SCAN_LIMIT).get()
  const list = r.data || []
  const stat = { scanned: list.length, blocked: 0, ok: 0, pending: 0, exhausted: 0 }

  for (const p of list) {
    let res
    try {
      res = await scanPost(p)
    } catch (e) {
      console.error('[secScan] 扫描异常', p._id, e && e.message)
      res = { verdict: 'pending', target: 'exception' }
    }

    const tries = Number(p.auditTries) || 0
    if (res.verdict === 'reject') {
      await db.collection('posts').doc(p._id).update({
        data: {
          audit: 'blocked',
          // prevVisibility 存原值：申诉通过时还原，否则「原本就仅自己可见」的内容会被误公开
          prevVisibility: p.visibility || 'all',
          visibility: 'private',
          auditAt: db.serverDate(),
          auditNote: 'secScan:' + res.target,
          auditTries: tries + 1
        }
      })
      stat.blocked++
    } else if (res.verdict === 'ok') {
      await db.collection('posts').doc(p._id).update({
        data: { audit: 'ok', auditAt: db.serverDate(), auditNote: '', auditTries: tries + 1 }
      })
      stat.ok++
    } else if (tries + 1 >= AUDIT_MAX_TRIES) {
      // 检测服务长时间不可用：收敛成 ok，别让这批永远占着巡检额度（fail-open 的必然结果）
      await db.collection('posts').doc(p._id).update({
        data: {
          audit: 'ok', auditAt: db.serverDate(),
          auditNote: 'tries-exhausted:' + res.target, auditTries: tries + 1
        }
      })
      stat.exhausted++
    } else {
      await db.collection('posts').doc(p._id).update({
        data: { auditAt: db.serverDate(), auditNote: res.target, auditTries: tries + 1 }
      })
      stat.pending++
    }
  }
  return stat
}

/** ② blocked 满 7 天 → 清掉 full 原图（只留 thumb 给作者辨认） */
async function purgeBlockedFull() {
  const cut = new Date(Date.now() - BLOCKED_KEEP_MS)
  const r = await db.collection('posts')
    .where({ audit: 'blocked', auditAt: _.lt(cut), fullPurged: _.neq(true) })
    .limit(SCAN_LIMIT).get()
  const list = r.data || []
  let n = 0
  for (const p of list) {
    const fulls = ((p.images || []).map((im) => im && im.fileID)).filter(Boolean)
    await deleteFiles(fulls)
    await db.collection('posts').doc(p._id).update({
      data: { fullPurged: true, purgedAt: db.serverDate() }
    })
    n++
  }
  return { purged: n }
}

/** ③ 清 30 天前的限流计数（day 是 'YYYY-MM-DD'，字典序比较即可） */
async function purgeRateLimit() {
  const cut = new Date(Date.now() - RATE_KEEP_DAYS * 24 * 3600 * 1000 + 8 * 3600 * 1000)
    .toISOString().slice(0, 10)
  const r = await db.collection('rateLimit').where({ day: _.lt(cut) }).limit(100).get()
  const list = r.data || []
  let n = 0
  for (const d of list) {
    try {
      await db.collection('rateLimit').doc(d._id).remove()
      n++
    } catch (e) { /* 忽略 */ }
  }
  return { removed: n, cut }
}

exports.main = async (event) => {
  const t0 = Date.now()
  console.log('[secScan] build =', BUILD, 'start')
  const out = { build: BUILD, ok: true }
  try {
    out.pending = await scanPending()
  } catch (e) {
    console.error('[secScan] scanPending 失败', e && e.message)
    out.pending = { error: String(e && e.message) }
    out.ok = false
  }
  try {
    out.purge = await purgeBlockedFull()
  } catch (e) {
    console.error('[secScan] purgeBlockedFull 失败', e && e.message)
    out.purge = { error: String(e && e.message) }
  }
  // 每天清一次就够（每 30 分钟跑一次，按小时整除 3 点/9 点…近似即可，成本极低）
  try {
    const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours()
    if (h === 4) out.rate = await purgeRateLimit()
  } catch (e) {
    console.error('[secScan] purgeRateLimit 失败', e && e.message)
  }
  out.cost = Date.now() - t0
  console.log('[secScan] done', JSON.stringify(out))
  return out
}
