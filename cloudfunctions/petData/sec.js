/**
 * sec.js · 内容安全与风控（PRD《内容安全与风控》v1.0）
 *
 * 用工厂函数而不是直接 module.exports 一堆方法：本文件不在自己里面 cloud.init()，
 * 由 index.js 初始化完再把 cloud / db 传进来（否则模块加载时 database() 会失败）。
 *
 * ── 三条红线（改这个文件前先读） ──────────────────────────────────
 * 1. fail-open：只有 87014 算违规。超时 / 网络错误 / 配额超限一律放行 + pending。
 *    「接口抖一下」绝不能翻译成「你违规了」——这个产品最大的敌人是用户懒得记。
 * 2. reject 必须删文件：图片是先上传再检测的，拦下来要把 thumbID + fileID 全删，
 *    否则每次拦截都留一批永远删不掉的孤儿文件。
 * 3. 不许过度留存违规原图：evidence 只存 thumb；blocked 满 7 天由 secScan 清 full。
 *
 * ── 与 PRD 的三处偏离（已与产品确认） ─────────────────────────────
 * · 白名单 key 用**图片内容 md5**而不是 thumbID：thumbID 每次上传都是新路径，
 *   用 thumbID 的话「用户重发同一张照片」永远命中不了白名单，PRD 验收第 7 条达不到。
 * · 整体超时预算 2500ms（PRD 写 1500ms）：发布本来就有压缩+上传，多 1s 用户无感；
 *   1500ms 在 9 图弱网下大概率全程超时 → 全是 pending，只能等 30 分钟后的巡检。
 * · 新用户前 3 天限流砍掉：前 3 天是留存最脆弱的窗口，这时候限流反噬最大。
 */
const https = require('https')
const crypto = require('crypto')

/** 发布侧整体检测预算（含文案 + 全部图片并发） */
const CHECK_BUDGET_MS = 2500
/** 文案单项上限：不给它吃掉整个预算 */
const TEXT_BUDGET_MS = 1200
/**
 * imgSecCheck 实战上限：文档写 1MB，实测 Buffer >100KB 就常报「图片太大」。
 * ⚠️ 这就是「必须拿 thumb 检测」的原因 —— thumb 闸门已压到 90KB（前端 THUMB_MAX_BYTES）
 */
const IMG_MAX_BYTES = 100 * 1024
/** 单账号每日发布条数 */
const DAILY_POST_LIMIT = 20
/** 单账号累计图片总量 */
const IMG_TOTAL_LIMIT = 500
/** 封禁缓存（云函数实例级，避免每个写操作都查库） */
const BAN_CACHE_MS = 30 * 1000

const TIMEOUT = { __secTimeout: true }

function withTimeout(p, ms) {
  let t = null
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(TIMEOUT), ms) })
  const done = () => { if (t) { clearTimeout(t); t = null } }
  return Promise.race([Promise.resolve(p), guard]).then((v) => { done(); return v }, (e) => { done(); throw e })
}

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex')
}

/** 极简 HTTPS JSON 请求（不引 axios，免去给 petData 加依赖与重装） */
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

/** multipart/form-data 上传（imgSecCheck 的 HTTPS 兜底要传二进制，不能用 JSON） */
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
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUND}`,
        'Content-Length': body.length
      }
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

module.exports = function createSec(cloud, db) {
  const _ = db.command

  let _token = null
  let _tokenAt = 0

  /** access_token（内存缓存 100 分钟；云函数容器复用期间不重复换） */
  async function accessToken() {
    if (_token && Date.now() - _tokenAt < 100 * 60 * 1000) return _token
    const ctx = cloud.getWXContext() || {}
    const appid = String(process.env.MINI_APPID || ctx.APPID || '').trim()
    const secret = String(process.env.MINI_APPSECRET || '').trim()
    if (!appid || !secret) throw new Error('NOCFG')
    const r = await httpsJson(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`)
    if (!r || !r.access_token) throw new Error('换 token 失败: ' + JSON.stringify(r))
    _token = r.access_token
    _tokenAt = Date.now()
    return _token
  }

  // ============ 文案检测 ============

  /**
   * @returns {{pass:boolean, unchecked?:boolean, reason?:string, suggest?:string}}
   *   pass=false → 命中风险内容，必须拒绝发布
   *   unchecked=true → 检测服务不可用（部署/资质问题），**放行但调用方要把 audit 记成 pending**，
   *                    别对用户宣称「已审核」
   */
  async function checkText(openid, text) {
    const t = String(text || '').trim()
    if (!t) return { pass: true, suggest: 'pass' }

    let cloudErr = ''
    try {
      const r = await cloud.openapi.security.msgSecCheck({ content: t, version: 2, scene: 2, openid })
      if (r && r.errCode === 0) {
        const sg = (r.result && r.result.suggest) || 'pass'
        return { pass: sg !== 'risky', suggest: sg }
      }
      cloudErr = 'errCode ' + (r && r.errCode)
    } catch (e) {
      cloudErr = String((e && (e.errCode || e.message)) || e)
    }

    try {
      const at = await accessToken()
      const r2 = await httpsJson('https://api.weixin.qq.com/wxa/msg_sec_check?access_token=' + at, 'POST',
        { content: t, version: 2, scene: 2, openid })
      if (r2 && r2.errcode === 0) {
        const sg = (r2.result && r2.result.suggest) || 'pass'
        return { pass: sg !== 'risky', suggest: sg }
      }
      if (r2 && r2.errcode === 87014) return { pass: false, suggest: 'risky' }
      console.error('[sec] msg_sec_check 兜底失败', JSON.stringify(r2), 'cloudErr=', cloudErr)
      return { pass: true, unchecked: true, reason: 'http ' + (r2 && r2.errcode) }
    } catch (e) {
      const msg = String((e && e.message) || e)
      console.warn('[sec] 文案检测不可用 cloudErr=' + cloudErr + ' fallbackErr=' + msg)
      return { pass: true, unchecked: true, reason: msg === 'NOCFG' ? 'not-configured' : msg }
    }
  }

  // ============ 图片检测 ============

  async function isWhitelisted(hash) {
    if (!hash) return false
    try {
      const r = await db.collection('auditWhitelist').where({ key: hash }).limit(1).get()
      return !!(r.data && r.data.length)
    } catch (e) {
      // 集合还没建 / 查询失败：按「没命中」处理，走正常检测（不因此放行违规内容）
      return false
    }
  }

  /** @returns {'ok'|'reject'|'error'} error = 服务不可用/异常，按 fail-open 处理 */
  async function checkImgBuffer(buf) {
    try {
      const r = await cloud.openapi.security.imgSecCheck({
        media: { contentType: 'image/jpeg', value: buf }
      })
      if (r && (r.errCode === 87014 || r.errcode === 87014)) return 'reject'
      return 'ok'
    } catch (e) {
      const code = e && (e.errCode !== undefined ? e.errCode : e.errcode)
      if (code === 87014) return 'reject'
      const msg = String((e && e.message) || e)
      console.warn('[sec] imgSecCheck 云调用失败，走 HTTPS 兜底:', msg.slice(0, 80))
    }
    try {
      const at = await accessToken()
      const r2 = await httpsMultipart(
        'https://api.weixin.qq.com/wxa/img_sec_check?access_token=' + at,
        'media', 'a.jpg', buf
      )
      if (r2 && r2.errcode === 87014) return 'reject'
      if (r2 && r2.errcode === 0) return 'ok'
      return 'error'
    } catch (e) {
      console.warn('[sec] img_sec_check 兜底也失败:', String((e && e.message) || e).slice(0, 80))
      return 'error'
    }
  }

  /** @returns {{result:'ok'|'reject'|'pending', note:string, bad?:Array, hashes?:string[]}} */
  async function checkImages(images, budgetMs) {
    const list = []
    ;(images || []).forEach((im) => {
      const id = im && (im.thumbID || im.fileID)
      if (id) list.push(id)
    })
    if (!list.length) return { result: 'ok', note: '' }

    const jobs = list.map(async (fileID) => {
      try {
        const r = await cloud.downloadFile({ fileID })
        const buf = r && r.fileContent
        if (!buf || !buf.length) return { verdict: 'error', note: 'empty', fileID }
        if (buf.length > IMG_MAX_BYTES) return { verdict: 'error', note: 'big:' + buf.length, fileID }
        const hash = md5(buf)
        if (await isWhitelisted(hash)) return { verdict: 'ok', note: 'whitelist', fileID, hash }
        const v = await checkImgBuffer(buf)
        return { verdict: v, fileID, hash, note: v === 'error' ? 'apierr' : '' }
      } catch (e) {
        return { verdict: 'error', note: String((e && e.message) || e).slice(0, 40), fileID }
      }
    })

    let outs
    try {
      outs = await withTimeout(Promise.all(jobs), budgetMs)
    } catch (e) {
      return { result: 'pending', note: e === TIMEOUT ? 'timeout' : 'error' }
    }
    const bad = outs.filter((o) => o.verdict === 'reject')
    if (bad.length) return { result: 'reject', note: 'risky', bad }
    const err = outs.filter((o) => o.verdict === 'error')
    if (err.length) return { result: 'pending', note: (err[0] && err[0].note) || 'error' }
    return { result: 'ok', note: '', hashes: outs.map((o) => o.hash).filter(Boolean) }
  }

  /**
   * 发布前的完整检测（文案 + 图片）
   * @returns {{result:'ok'|'reject'|'pending', target:'text'|'image'|'', note:string}}
   */
  async function checkBeforePublish(openid, content, images) {
    /**
     * 测试开关：`SEC_FORCE_REJECT` 环境变量填**某个 openid** 时，这个人发的任何图文都会被拒。
     *
     * 为什么需要：真实违规素材没法在验收时构造（我们手上没有、也不该持有违规图），
     * 但「命中之后系统做什么」—— 拒绝入库 + 删掉已上传的文件 + 前端弹窗 + 不计数 ——
     * 必须能被完整走一遍，否则上线时这段逻辑是**从未执行过**的。
     *
     * ⚠️ 安全边界：只对这个 openid 生效，**不配 = 完全不生效**；
     *    即便忘了关，影响范围也只有那一个测试账号，不会误伤真实用户。
     *    上线前请在环境变量里删掉它。
     */
    const force = String(process.env.SEC_FORCE_REJECT || '').trim()
    if (force && force === openid) {
      console.warn('[sec] SEC_FORCE_REJECT 命中，强制拒收（测试开关）')
      return { result: 'reject', target: 'test', note: 'forced' }
    }

    const t0 = Date.now()
    const left = () => CHECK_BUDGET_MS - (Date.now() - t0)
    const notes = []
    let pendingTarget = ''

    if (content) {
      try {
        const r = await withTimeout(checkText(openid, content), Math.max(300, Math.min(TEXT_BUDGET_MS, left())))
        if (r && r.pass === false) return { result: 'reject', target: 'text', note: 'risky' }
        if (r && r.unchecked) {
          notes.push('text:' + (r.reason || 'unchecked'))
          pendingTarget = pendingTarget || 'text'
        }
      } catch (e) {
        notes.push('text:' + (e === TIMEOUT ? 'timeout' : 'error'))
        pendingTarget = pendingTarget || 'text'
      }
    }

    const im = await checkImages(images, Math.max(300, left()))
    if (im.result === 'reject') return { result: 'reject', target: 'image', note: 'risky' }
    if (im.result === 'pending') {
      notes.push('image:' + im.note)
      pendingTarget = pendingTarget || 'image'
    }

    if (notes.length) return { result: 'pending', target: pendingTarget, note: notes.join(',') }
    return { result: 'ok', target: '', note: '' }
  }

  // ============ 文件清理 ============

  /**
   * 管理端批量删云文件（单次 ≤50）
   * ⚠️ 前端 wx.cloud.deleteFile 只能删自己传的文件，owner 删 member 的图会静默失败
   */
  async function deleteFiles(fileIDs) {
    const list = (fileIDs || []).filter(Boolean)
    if (!list.length) return { removed: 0, failed: 0 }
    let removed = 0
    let failed = 0
    for (let i = 0; i < list.length; i += 50) {
      try {
        await cloud.deleteFile({ fileList: list.slice(i, i + 50) })
        removed += Math.min(50, list.length - i)
      } catch (e) {
        failed += Math.min(50, list.length - i)
        console.error('[sec] deleteFile 失败（文件留待 secScan/人工清理）', e && e.message)
      }
    }
    return { removed, failed }
  }

  /** 一条 post 的全部云文件（thumb + full） */
  function postFiles(post) {
    const out = []
    ;((post && post.images) || []).forEach((im) => {
      if (im && im.thumbID) out.push(im.thumbID)
      if (im && im.fileID && im.fileID !== im.thumbID) out.push(im.fileID)
    })
    return out
  }

  // ============ 封禁 ============

  const _banCache = {}

  async function isBanned(openid) {
    if (!openid) return null
    const hit = _banCache[openid]
    if (hit && Date.now() - hit.at < BAN_CACHE_MS) return hit.ban
    let ban = null
    try {
      const r = await db.collection('banned')
        .where({ openid, status: 'active' }).limit(1).get()
      ban = (r.data && r.data[0]) || null
    } catch (e) {
      // 集合不存在 / 查询失败：按「未封禁」放行，不能因为风控库挂了挡住全部用户
      console.warn('[sec] banned 查询失败，按未封禁处理', e && e.message)
      ban = null
    }
    _banCache[openid] = { at: Date.now(), ban }
    return ban
  }

  function clearBanCache(openid) {
    if (openid) delete _banCache[openid]
    else Object.keys(_banCache).forEach((k) => delete _banCache[k])
  }

  /** 封禁时把该用户全部 posts 下架（先下架不清数据，留 7 天申诉期） */
  async function takeDownAllPosts(openid) {
    try {
      const r = await db.collection('posts').where({ createdBy: openid }).limit(1000).get()
      const list = r.data || []
      let n = 0
      for (const p of list) {
        if (p.visibility === 'private' && p.audit === 'blocked') continue
        await db.collection('posts').doc(p._id).update({
          data: {
            prevVisibility: p.visibility || 'all',
            visibility: 'private',
            audit: 'blocked',
            auditAt: db.serverDate(),
            auditNote: '封禁连带下架'
          }
        })
        n++
      }
      return n
    } catch (e) {
      console.error('[sec] 封禁连带下架失败', e && e.message)
      return 0
    }
  }

  // ============ 频率与总量 ============

  /** 北京时间「今天」（云函数里 new Date() 是 UTC，取日期必须 +8h —— 踩过） */
  function todayKey() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  }

  async function myImgTotal(openid) {
    try {
      const u = await db.collection('users').where({ _openid: openid }).limit(1).get()
      const one = u.data && u.data[0]
      return one ? Number(one.imgTotal) || 0 : 0
    } catch (e) {
      return 0
    }
  }

  /**
   * 发布前的频率/总量校验（**不在这里自增**，发布成功后再 bump —— 被 reject 的不计数）
   * @returns {{ok:boolean, code?:'daily'|'total', msg?:string}}
   */
  async function checkRate(openid, imgCount) {
    const total = await myImgTotal(openid)
    if (total + (imgCount || 0) > IMG_TOTAL_LIMIT) {
      return { ok: false, code: 'total', msg: '空间已满，联系我们' }
    }
    const id = `${openid}_${todayKey()}`
    try {
      const r = await db.collection('rateLimit').doc(id).get().catch(() => null)
      const c = Number((r && r.data && r.data.count) || 0)
      if (c >= DAILY_POST_LIMIT) {
        return { ok: false, code: 'daily', msg: '今天记录得够多啦，明天再来' }
      }
    } catch (e) { /* 读不到就当 0，不因此拦人 */ }
    return { ok: true }
  }

  /** 发布成功后自增（一律 _.inc 原子操作，绝不读改写 —— 在这上面踩过数据被覆盖的坑） */
  async function bumpRate(openid, imgCount) {
    const id = `${openid}_${todayKey()}`
    try {
      await db.collection('rateLimit').doc(id).update({ data: { count: _.inc(1) } })
    } catch (e) {
      try {
        await db.collection('rateLimit').add({ data: { _id: id, openid, day: todayKey(), count: 1 } })
      } catch (e2) {
        // 并发下另一个实例刚 add 过 → 再 inc 一次
        await db.collection('rateLimit').doc(id).update({ data: { count: _.inc(1) } }).catch(() => {})
      }
    }
    if (!imgCount) return
    try {
      const u = await db.collection('users').where({ _openid: openid }).limit(1).get()
      const one = u.data && u.data[0]
      if (one) {
        await db.collection('users').doc(one._id).update({ data: { imgTotal: _.inc(imgCount) } })
      } else {
        await db.collection('users').add({ data: { _openid: openid, imgTotal: imgCount } }).catch(() => {})
      }
    } catch (e) {
      console.warn('[sec] imgTotal 自增失败（不阻断发布）', e && e.message)
    }
  }

  return {
    CHECK_BUDGET_MS,
    IMG_MAX_BYTES,
    DAILY_POST_LIMIT,
    IMG_TOTAL_LIMIT,
    TIMEOUT,
    withTimeout,
    md5,
    accessToken,
    httpsJson,
    httpsMultipart,
    checkText,
    isWhitelisted,
    checkImgBuffer,
    checkImages,
    checkBeforePublish,
    deleteFiles,
    postFiles,
    isBanned,
    clearBanCache,
    takeDownAllPosts,
    todayKey,
    checkRate,
    bumpRate
  }
}
