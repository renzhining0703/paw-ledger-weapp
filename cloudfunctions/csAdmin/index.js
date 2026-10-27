/**
 * 云函数 csAdmin：客服运营后台的数据读写（PRD R8）
 *
 * 鉴权两道：
 *   ① 口令：环境变量 CS_ADMIN_TOKEN，请求必须带同样的 token（fail-close）
 *   ② 账号白名单：环境变量 CS_ADMIN_OPENIDS，只放行名单里的微信账号
 *
 * 环境变量：
 *   CS_ADMIN_TOKEN    运营后台口令（**自己编的一串字符**，不是微信给的）
 *                     只在「还没配白名单」的阶段必须填；配好白名单后它变成可选，
 *                     不填也能进（此时身份由 openid 保证）
 *   CS_ADMIN_OPENIDS  允许进运营后台的微信 openid，多个用英文逗号分隔
 *                     ⚠️ 不配 = 不限制（任何知道口令的人都能进）
 *                     用于首次拿自己的 openid：不配时调 whoami 会返回 myOpenid，
 *                     抄下来填进去，再重新部署就锁定了
 *
 * actions：
 *   whoami    【无鉴权】信息最小化：只回 locked + myOpenid（拿自己 openid 去配白名单用的引导口）
 *             ⚠️ 不回 isAdmin / adminCount —— 这是全网唯一不需要任何凭证就能打的 action，
 *                能少给侦查方一个比特就少给一个比特
 *   probe     【过闸】权限探测：服务端判完只回 { ok, locked } 一个布尔，前端据此显隐入口
 *             —— 身份判断永远在服务端，前端显隐只是 UI，不是安全边界
 *   wipeUser  { openid, confirm } 一键清空某用户全部数据（隐私政策注销承诺），confirm 必须逐字传「确认清空」
 *   overview  返回当前全部客服配置 + 各触点点击/会话/群码计数
 *   setWelcome    { text }
 *   setHours      { start, end, text }
 *   setGroupMap   { map: { source: groupKey } }
 *   setGroupCode  { group, base64 }  上传群码图到云存储并更新配置
 *   listSessions  会话列表（读 csSessions 摘要）
 *   listMessages  { openid }  某个用户的消息流
 *   reply         { openid, text }  运营回复（微信限制：用户 48h 内发过消息才能回）
 *   selfcheck     链路自检：逐集合报存在性与条数 + 一句结论（排「消息收不到」用）
 */

const cloud = require('wx-server-sdk')
const axios = require('axios')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

const BUILD = '20261026-sec'

/** 五个触点的 source（与前端 utils/cs.js 的 SOURCES、云侧 group_map 保持一致） */
const SOURCES = ['mine_ask', 'milestone_birthday', 'share_done', 'health_unknown', 'remind_landing']

const WELCOME_DEFAULT = [
  '你好，我是店长。养宠的问题直接问就行，我看到就回。',
  '想和同样在记录的人聊聊的话，回复「群」。'
].join('\n')

const AFTER_HOURS_DEFAULT = '这会儿我不在线，看到就回你。急的话先描述一下它的情况，我明早一早处理。'
const HOURS_DEFAULT = { start: 9, end: 22 }
const GROUP_INTRO_DEFAULT = '群里可以问问题、晒它的照片，也会不定期分享养宠的东西。上面这张是入群二维码，长按识别就行。'
const GROUP_MAP_DEFAULT = {
  mine_ask: 'A',
  milestone_birthday: 'B',
  share_done: 'C',
  health_unknown: 'A',
  remind_landing: 'A'
}

/**
 * 内置 FAQ 规则（与 cloudfunctions/customer/index.js 的 FAQ_DEFAULT 是同一份，
 * 云函数之间无法共享代码文件，改一处记得同步另一处）
 * ⚠️ 顺序即优先级，取第一条命中的规则
 */
const FAQ_DEFAULT = [
  { keys: ['群', '进群', '加群', '社群', '交流', '组织'], kind: 'group_code' },
  {
    keys: ['疫苗', '打针', '接种', '三联', '狂犬', '第几针'],
    kind: 'text',
    text: '猫狗常规是：幼年期猫三联/犬四联打 3 针（每针间隔 21 天），之后每年加强 1 针；狂犬满 3 月龄就能打，之后每年 1 针。具体以医院为准 —— 你在「健康」页记一针，下次到期前一天会自动提醒你。'
  },
  {
    keys: ['驱虫', '体内', '体外', '多久', '频率', '拜宠清'],
    kind: 'text',
    text: '常规节奏：体内 3 个月一次，体外 1 个月一次（夏天或常出门可以加密到 3 周）。药不用固定一种，轮换着用反而更好。在「健康」页记一次，到期会自动提醒。'
  },
  {
    keys: ['异宠', '守宫', '蛇', '龟', '仓鼠', '兔', '鸟', '蜜袋鼯'],
    kind: 'text',
    text: '异宠基本没有常规疫苗要打（守宫、蛇、龟、仓鼠都不需要），重点是环境：温度梯度、湿度、垫材和食物单一性。你说一下物种和现在的状态，我帮你看哪里可以调。'
  }
]

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function stamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

function withTimeout(p, ms, tag) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + tag)), ms))
  ])
}

/**
 * 把 db.serverDate() 写进去的时间字段转成毫秒时间戳
 *
 * ⚠️ 为什么必须在云函数里转：
 *    这个字段经 callFunction 序列化到前端后，可能是 Date / ISO 字符串 / {$date:...} / 数字
 *    —— 前端原来写的是 `Date.parse(String(x).replace('T',' ').replace('Z',''))`，
 *    而 **iOS 的 Date.parse 不接受「YYYY-MM-DD HH:mm:ss」这种带空格的格式** → NaN →
 *    时间戳全变成 0 → 消息气泡下面一个时间都不显示（已踩：模拟器能过、真机空白）。
 *    Node / DevTools 能解析，所以这类问题本地永远复现不出来。
 */
function tsOf(v) {
  if (!v) return 0
  if (typeof v === 'number') return v
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'object') {
    // 云开发序列化形态：{$date: '...'} 或 {$timestamp: {...}}
    if (v.$date != null) return tsOf(v.$date)
    if (v.$timestamp != null) {
      const t = v.$timestamp
      if (typeof t === 'number') return t
      if (t.$date != null) return tsOf(t.$date)
      if (t.seconds != null) return Number(t.seconds) * 1000
    }
    if (v.value != null) return tsOf(v.value)
    return 0
  }
  if (typeof v === 'string') {
    const s = v.trim()
    // 纯数字串（毫秒时间戳）
    if (/^\d+$/.test(s)) return Number(s)
    // ISO / 带空格：把空格换回 T；没有时区标记就按 UTC 处理
    const iso = s.replace(' ', 'T')
    const d = new Date(/[Zz]$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z')
    const t = d.getTime()
    return isNaN(t) ? 0 : t
  }
  return 0
}

/** 把云开发的报错压成一句人话（原始 errMsg 太长，前端放不下） */
function shortErr(e) {
  const m = String((e && (e.errMsg || e.message)) || e || '')
  if (/collection not exists|not exist|DATABASE_COLLECTION_NOT_EXIST/i.test(m)) return '集合不存在'
  if (/timeout/i.test(m)) return '超时'
  if (/permission|PERMISSION/i.test(m)) return '没有读写权限'
  return m.slice(0, 60) || '未知错误'
}

/**
 * 链路自检：只回答一个问题 ——「用户发的消息为什么没出现在会话列表里」
 *
 * ⚠️ `listSessions` / `listMessages` 都用 `.catch(() => null)` 兜底，
 *    集合不存在时返回空数组，界面上跟「真的没人发消息」**长得一模一样**。
 *    已踩：用户以为消息没收到，实际是 csSessions / csMessages 集合压根没建，
 *    customer 那边的写入全被 catch 吞掉，控制台只剩一行「写入失败」。
 *    所以自检**不吞异常**，逐个集合报存在性与条数，并给一句结论。
 */
const CHECK_COLS = [
  ['csConfig', '云端配置（话术 / 群码）'],
  ['csSessions', '会话账本（列表读它）'],
  ['csMessages', '消息留痕（会话内容）'],
  ['csQuota', '下发额度（48h / 60s）'],
  ['csOutbox', '待发队列（群码 / 提醒重试）']
]

async function selfcheck() {
  const cols = []
  for (let i = 0; i < CHECK_COLS.length; i++) {
    const col = CHECK_COLS[i][0]
    const label = CHECK_COLS[i][1]
    try {
      const r = await withTimeout(db.collection(col).count(), 6000, 'cnt-' + col)
      cols.push({ col, label, ok: true, count: (r && r.total) || 0 })
    } catch (e) {
      cols.push({ col, label, ok: false, count: 0, err: shortErr(e) })
    }
  }
  const pick = (c) => cols.filter((x) => x.col === c)[0] || { ok: false, count: 0 }
  const missing = cols.filter((x) => !x.ok).map((x) => x.col)

  // 最近 5 条用户消息：先看清楚用户到底发了什么（可能发的是图片，或压根没带「群」字）
  const recentIn = []
  if (pick('csMessages').ok && pick('csMessages').count > 0) {
    try {
      const r = await withTimeout(
        db.collection('csMessages').orderBy('createdAt', 'desc').limit(20).get(),
        6000, 'recentIn'
      ).catch(() => null)
      ;((r && r.data) || []).forEach((m) => {
        if (recentIn.length >= 5) return
        if (String(m.dir || 'in') !== 'in') return
        recentIn.push({
          content: String(m.content || ''),
          msgType: String(m.msgType || ''),
          ts: tsOf(m.createdAt)
        })
      })
    } catch (e) { /* 无所谓 */ }
  }
  const lastIn = recentIn.length ? recentIn[0].content : ''
  const lastInAt = recentIn.length ? recentIn[0].ts : 0

  /**
   * 队列诊断
   * 「回复群没收到二维码」有四种断法，必须分开报，否则只能靠猜：
   *   ① 队列里压根没这条      → 没命中 FAQ / csOutbox 集合不存在
   *   ② 入队时就是 failed     → 群码没配到对应群（配置问题）
   *   ③ 一直 pending         → csSend 没在跑（没部署 / 定时触发器没生效）
   *   ④ 一直 retrying 后失败  → 发送环节报错（额度、素材、fileID 失效），看 lastErr
   */
  const queue = { pending: 0, sent: 0, failed: 0 }
  let lastOut = null
  if (pick('csOutbox').ok) {
    try {
      const r = await withTimeout(
        db.collection('csOutbox').orderBy('createdAt', 'desc').limit(30).get(),
        6000, 'outbox'
      ).catch(() => null)
      const rows = (r && r.data) || []
      rows.forEach((o) => {
        const st = String(o.status || '')
        if (queue[st] != null) queue[st] += 1
      })
      const o = rows[0]
      if (o) {
        const ts = tsOf(o.createdAt)
        lastOut = {
          kind: String(o.kind || ''),
          status: String(o.status || ''),
          retry: Number(o.retry || 0),
          group: (o.payload && o.payload.group) || '',
          source: (o.payload && o.payload.source) || '',
          hasFile: !!(o.payload && o.payload.fileID),
          lastErr: String(o.lastErr || ''),
          ts,
          // 入队到现在过了几分钟：pending 超过 2 分钟没动，基本就是 csSend 没在跑
          ageMin: ts ? Math.round((Date.now() - ts) / 60000) : -1
        }
      }
    } catch (e) { /* 队列诊断失败不影响主结论 */ }
  }
  const codes = (await getConfig('group_code', {})) || {}
  const codeGroups = ['A', 'B', 'C'].filter((g) => codes[g] && codes[g].fileID)

  /**
   * 下发额度诊断
   * csSend 发群码要先 consume 两次（图片 + 说明文本），额度耗尽会直接 throw
   * 「无下发额度」，而运营侧完全看不到 —— 只表现为「码没发出来」
   */
  let quota = null
  if (pick('csQuota').ok && pick('csQuota').count > 0) {
    try {
      const qr = await withTimeout(
        db.collection('csQuota').orderBy('updatedAt', 'desc').limit(1).get(),
        6000, 'quota'
      ).catch(() => null)
      const q = ((qr && qr.data) || [])[0]
      if (q) {
        const now = Date.now()
        quota = {
          eN: Number(q.eN || 0),
          eOk: Number(q.eExp || 0) > now,
          mN: Number(q.mN || 0),
          mOk: Number(q.mExp || 0) > now
        }
      }
    } catch (e) { /* 无所谓 */ }
  }

  return {
    queue,
    lastOut,
    quota,
    recentIn,
    // 哪些群配了码（只回标识，不回 fileID）
    codeGroups,
    ok: true,
    build: BUILD,
    cols,
    missing,
    lastIn,
    lastInAt,
    verdict: selfcheckVerdict(cols, missing, pick, lastInAt, queue, codeGroups, lastOut, quota, recentIn)
  }
}

function selfcheckVerdict(cols, missing, pick, lastInAt, queue, codeGroups, lastOut, quota, recentIn) {
  if (missing.length) {
    return '缺集合：' + missing.join(' / ') + '。云开发不会自动建集合，'
      + '先在「数据库」里手工新建（权限选「所有用户不可读写」，只让云函数读写），'
      + '再让用户发一条消息重试。'
  }
  if (pick('csMessages').count === 0) {
    return '消息一次都没进来过。按顺序查：① customer 云函数是否已「上传并部署」'
      + ' ② 云开发 → 设置 → 其他设置 → 消息推送，text / image / event 三条规则是否都指向 customer、'
      + '环境是否选对 ③ mp 后台「在官方客服工作台收发消息」必须关掉'
  }
  if (pick('csSessions').count === 0) {
    return '消息进来了但会话账本为空：customer 不是最新版本（旧版没写 lastMsg / lastAt），重新部署 customer'
  }
  if (!lastInAt) {
    return '有消息记录，但没有 dir=in 的用户消息；可能只回发过、没收到过。查消息推送规则'
  }

  // ⚠️ 队列诊断放在最后：只有消息链路通了，讨论「群码为什么没发」才有意义
  const q = queue || { pending: 0, sent: 0, failed: 0 }

  // ① 用户最近发的根本没带「群」字，或发的是图片 —— 那不发码是正确行为
  if (recentIn && recentIn.length) {
    const hit = recentIn.filter((m) => String(m.content || '').indexOf('群') !== -1)
    if (!hit.length) {
      return '最近的用户消息里没有一条含「群」字（最近是「'
        + String(recentIn[0].content || '').slice(0, 12) + '」）—— 没发码是预期行为。'
        + '让用户直接发「群」两个字试试。'
    }
  }

  if (!codeGroups.length) {
    return 'A / B / C 三个群一个码都没配：在「群码」页签上传任意一张，用户回复「群」才会发。'
  }

  // ② 队列里根本没有这条 → 没入队
  if (!lastOut) {
    return '队列里一条记录都没有：customer 没有入队。'
      + '① csOutbox 集合是否已建 ② customer 是否是最新版（旧版读不到 group_map.map，'
      + '会永远落到 A 群）③ 重新部署 customer'
  }

  // ③ 入队即 failed / 重试后 failed → 看具体错误
  if (lastOut.status === 'failed') {
    if (!lastOut.hasFile) {
      return '入队时群 ' + (lastOut.group || '?') + ' 没有 fileID（已配码的群：'
        + codeGroups.join('/') + '）—— 先去「群码」页签给这个群上传，再让用户重新发一次。'
    }
    return '发送失败（重试 ' + lastOut.retry + ' 次后放弃）：' + (lastOut.lastErr || '未知')
      + '。修好后要让用户**重新发一次**，已失败的记录不会自动重投。'
  }

  if (lastOut.status === 'pending' && lastOut.ageMin >= 2) {
    return '队列里这条已经等了 ' + lastOut.ageMin + ' 分钟还没发：csSend 没在跑。'
      + '① csSend 云函数是否已「上传并部署」② 控制台 → 云函数 → csSend →'
      + '「定时触发器」是否已创建并启用（config.json 里声明了不代表已生效）'
  }

  // 额度：csSend 发群码要连扣两条，额度没了会报「无下发额度」
  if (quota && !quota.eOk && !quota.mOk) {
    return '下发额度两个窗口都过期了。群码要连扣两条（图片 + 说明文本），'
      + '额度不够会直接失败。让用户再发一条消息刷新额度后重试。'
  }

  if (q.pending > 0) {
    return '队列里有 ' + q.pending + ' 条待发，最近一条刚入队（' + (lastOut.ageMin >= 0 ? lastOut.ageMin : '?')
      + ' 分钟前）—— csSend 每分钟跑一次，再等一分钟看看。'
  }

  return '链路正常：消息能进来、会话账本有摘要、队列无积压、群码已配（'
    + codeGroups.join('/') + '）。若列表仍为空，点一次「刷新」'
}

async function getConfig(id, fallback) {
  try {
    const r = await withTimeout(db.collection('csConfig').doc(id).get(), 5000, 'cfg-' + id)
    return (r && r.data) || fallback
  } catch (e) {
    return fallback
  }
}

/**
 * 写入配置文档
 * ⚠️ 文档可能还不存在（首次使用），所以 add / update 都要走：
 *    先探一次，存在则 update，不存在则 add。不能直接 update —— 首次会静默失败。
 */
async function setConfig(id, data) {
  const patch = Object.assign({ _id: id, updatedAt: db.serverDate() }, data)
  let exists = false
  try {
    await withTimeout(db.collection('csConfig').doc(id).get(), 5000, 'exists-' + id)
    exists = true
  } catch (e) { exists = false }
  if (exists) {
    return withTimeout(db.collection('csConfig').doc(id).update({ data: patch }), 5000, 'set-' + id)
  }
  return withTimeout(db.collection('csConfig').add({ data: patch }), 5000, 'add-' + id)
}

/** 数某个事件 + 某个 source 的条数 */
/**
 * 换 access_token（与 customer / csSend 同一套实现，云函数间无法共享代码文件）
 * ⚠️ 不用 cloud.openapi：本项目是个人主体，云调用会报 -501001
 */
async function getAccessToken() {
  const ctx = cloud.getWXContext() || {}
  // ⚠️ 定时触发器 / 云端手动测试这类非用户调用场景下 getWXContext().APPID 可能是空的
  const appid = String(process.env.MINI_APPID || ctx.APPID || '').trim()
  const secret = String(process.env.MINI_APPSECRET || '').trim()
  if (!secret) throw new Error('缺少环境变量 MINI_APPSECRET')
  if (!appid) throw new Error('取不到 appid：请给 csAdmin 云函数配环境变量 MINI_APPID')

  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const r = await axios.get(url, { timeout: 8000 })
  if (!r.data || !r.data.access_token) {
    console.error('[csAdmin] 换 token 失败 appid 尾号=', String(appid).slice(-4),
      '长度=', String(appid).length, '返回=', JSON.stringify(r.data))
    throw new Error('获取 access_token 失败: ' + JSON.stringify(r.data))
  }
  return r.data.access_token
}

/** 调客服消息接口下发（字段名一律下划线/小写：touser / msgtype / text.content） */
async function sendText(openid, content, token) {
  const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`
  const r = await axios.post(url, { touser: openid, msgtype: 'text', text: { content } }, { timeout: 8000 })
  return r.data || {}
}

async function findOne(col, where) {
  const r = await withTimeout(db.collection(col).where(where).limit(1).get(), 5000, 'find-' + col)
    .catch(() => null)
  return (r && r.data && r.data[0]) || null
}

/**
 * 是否还有下发额度
 * ⚠️ 客服消息的硬限制：只能在用户「48 小时内发过消息」或「刚进入会话 1 分钟内」时回。
 *    超出窗口就发不出去，这时候要如实告诉运营，不能假装发送成功。
 */
async function hasQuota(openid) {
  const now = Date.now()
  const q = await findOne('csQuota', { openid })
  if (!q) return false
  return (q.eExp > now && q.eN > 0) || (q.mExp > now && q.mN > 0)
}

/** 消耗一条额度（先扣未过期的窗口 E，再扣窗口 M） */
async function consume(openid) {
  const now = Date.now()
  const q = await findOne('csQuota', { openid })
  if (!q) return false
  if (q.eExp > now && q.eN > 0) {
    await withTimeout(
      db.collection('csQuota').doc(q._id).update({ data: { eN: q.eN - 1, updatedAt: db.serverDate() } }),
      5000, 'consume-e'
    ).catch(() => null)
    return true
  }
  if (q.mExp > now && q.mN > 0) {
    await withTimeout(
      db.collection('csQuota').doc(q._id).update({ data: { mN: q.mN - 1, updatedAt: db.serverDate() } }),
      5000, 'consume-m'
    ).catch(() => null)
    return true
  }
  return false
}

/**
 * 批量取用户昵称头像
 * 客服推送只带 FromUserName（openid），**没有昵称** —— 不查这一步，
 * 运营看到的就只有一串尾号，根本不知道是谁在问。
 * 昵称头像在 users 集合（用户在小程序「我的」页自己填的，settings.nickname / settings.avatar）。
 *
 * @param {string[]} openids
 * @returns {Promise<Object>} openid → { nickname, avatar }
 */
async function namesOf(openids) {
  const map = {}
  const list = (openids || []).filter(Boolean)
  if (!list.length) return map
  try {
    const r = await withTimeout(
      db.collection('users')
        .where({ _openid: _.in(list) })
        .limit(100)
        .field({ _openid: true, settings: true })
        .get(),
      6000, 'names'
    )
    ;(r && r.data ? r.data : []).forEach((u) => {
      const s = (u && u.settings) || {}
      map[u._openid] = {
        nickname: String(s.nickname || '').trim(),
        avatar: String(s.avatar || '').trim(),
        petName: ''
      }
    })
  } catch (e) {
    // users 集合不存在 / 权限异常都不该拖垮会话列表，昵称退化成 openid 尾号
    console.warn('[csAdmin] 读昵称失败（退化为尾号）', shortErr(e))
  }

  /**
   * 再按 ownerOpenid 补一次宠物名
   * 大多数人根本没在小程序里填过昵称，「朵屁」这种宠物名反而最好认。
   * 用户只要建过档案，这里就能对上人 —— 不必依赖 session-from 带过来的 pet 参数。
   */
  try {
    const pr = await withTimeout(
      db.collection('pets')
        .where({ ownerOpenid: _.in(list) })
        .limit(100)
        .field({ ownerOpenid: true, name: true, species: true })
        .get(),
      6000, 'pets'
    )
    ;(pr && pr.data ? pr.data : []).forEach((p) => {
      const cur = map[p.ownerOpenid]
      if (!cur) return
      if (!cur.petName) cur.petName = String(p.name || '').trim()
      if (!cur.petSpecies) cur.petSpecies = String(p.species || '').trim()
    })
  } catch (e) {
    console.warn('[csAdmin] 读宠物名失败（不影响会话列表）', shortErr(e))
  }

  return map
}

/** 会话列表：直接读 csSessions（customer 已维护好摘要字段，不用聚合 csMessages） */
async function listSessions() {
  const r = await withTimeout(
    db.collection('csSessions').orderBy('lastAt', 'desc').limit(50).get(),
    8000, 'sessions'
  ).catch(() => null)
  const list = (r && r.data) || []
  const names = await namesOf(list.map((s) => s.openid))
  return {
    ok: true,
    sessions: list.map((s) => {
      const n = names[s.openid] || {}
      return {
        openid: s.openid,
        // 昵称查不到就退回 openid 尾号（不是「未知用户」—— 尾号至少能区分是谁）
        nickname: n.nickname || '',
        avatar: n.avatar || '',
        who: String(s.openid || '').slice(-6),
        // 会话账本里的宠物名来自 session-from；没有就用 pets 表按 ownerOpenid 反查到的
        petName: s.petName || n.petName || '',
        species: s.species || n.petSpecies || '',
        species: s.species || '',
        source: s.source || '',
        lastMsg: s.lastMsg || '',
        lastAt: s.lastAt || 0,
        unread: s.unread || 0
      }
    })
  }
}

/** 某个用户的消息流 */
async function listMessages(openid) {
  if (!openid) return { ok: false, err: '缺少 openid' }
  const r = await withTimeout(
    db.collection('csMessages').where({ openid }).orderBy('createdAt', 'asc').limit(200).get(),
    8000, 'messages'
  ).catch(() => null)
  const list = (r && r.data) || []
  const names = await namesOf([openid])
  const n = names[openid] || {}
  // 宠物名从会话账本取：没设昵称的用户，「朵屁」这种宠物名比 openid 尾号好认得多
  const sess = await findOne('csSessions', { openid })
  return {
    ok: true,
    peer: {
      nickname: n.nickname || '',
      avatar: n.avatar || '',
      petName: (sess && sess.petName) || n.petName || '',
      species: (sess && sess.species) || n.petSpecies || '',
      who: String(openid).slice(-6)
    },
    messages: list.map((m) => ({
      dir: m.dir || 'in',
      msgType: m.msgType || 'text',
      content: m.content || '',
      source: m.source || '',
      // ⚠️ 时间戳一律在云函数里转成数字再下发（原因见 tsOf 的注释）
      ts: tsOf(m.createdAt)
    }))
  }
}

/** 进会话即清未读（否则轮询期间未读数会一直涨，可消息其实已经看到了） */
async function markRead(openid) {
  if (!openid) return { ok: false, err: '缺少 openid' }
  const s = await findOne('csSessions', { openid })
  if (!s) return { ok: true }
  await db.collection('csSessions').doc(s._id).update({ data: { unread: 0 } }).catch(() => null)
  return { ok: true }
}

/**
 * 运营回复
 * ⚠️ 前置校验顺序不能变：先判额度 → 再扣额度 → 再发 → 再留痕。
 *    反过来会出现「发成功了但没记账」或「扣了额度却没发出去」
 */
async function reply(openid, text) {
  const content = String(text || '').trim()
  if (!openid) throw new Error('缺少 openid')
  if (!content) throw new Error('消息不能为空')
  if (content.length > 600) throw new Error('太长了，请拆成几条发')

  if (!(await hasQuota(openid))) {
    // 如实告知：用户 48 小时内没发过消息时，客服消息接口就是发不出去
    throw new Error('发不出去：这位用户已超过 48 小时没有新消息，客服消息接口不允许主动发送')
  }
  const token = await getAccessToken()
  if (!(await consume(openid))) throw new Error('额度刚刚用完了，稍等用户再发一条消息')

  const res = await sendText(openid, content, token)
  if (res.errcode) throw new Error('发送失败（' + res.errcode + '）：' + (res.errmsg || ''))

  // 留痕 + 清未读
  await withTimeout(db.collection('csMessages').add({
    data: {
      _openid: openid,
      openid,
      dir: 'out',
      msgType: 'text',
      content,
      source: '',
      createdAt: db.serverDate()
    }
  }), 5000, 'log-out').catch(() => null)

  const sess = await findOne('csSessions', { openid })
  if (sess) {
    await withTimeout(
      db.collection('csSessions').doc(sess._id)
        .update({ data: { lastMsg: content.slice(0, 30), lastAt: Date.now(), unread: 0 } }),
      5000, 'upd-sess'
    ).catch(() => null)
  }
  return { ok: true }
}

async function countEvent(event, source) {
  const where = { event }
  if (source) where['props.source'] = source
  const r = await withTimeout(db.collection('events').where(where).count(), 6000, 'cnt-' + event)
    .catch(() => ({ total: -1 }))
  return (r && r.total) || 0
}

async function overview() {
  const [welcome, hours, faq, groupMap, groupCode, groupIntro] = await Promise.all([
    getConfig('welcome', { text: WELCOME_DEFAULT }),
    getConfig('hours', Object.assign({ text: AFTER_HOURS_DEFAULT }, HOURS_DEFAULT)),
    getConfig('faq', { rules: [] }),
    getConfig('group_map', { map: GROUP_MAP_DEFAULT }),
    getConfig('group_code', {}),
    getConfig('group_intro', { text: GROUP_INTRO_DEFAULT })
  ])

  // 云开发数据库没有 group by，逐个 source 数（触点只有 5 个，量可接受）
  const stats = []
  for (const s of SOURCES) {
    const opened = await countEvent('contact_opened', s)
    const sent = await countEvent('msg_sent', s)
    const code = await countEvent('group_code_sent', s)
    stats.push({ source: s, opened, sent, code })
  }

  return {
    ok: true,
    build: BUILD,
    welcome: welcome.text || WELCOME_DEFAULT,
    hours: {
      start: hours.start != null ? hours.start : HOURS_DEFAULT.start,
      end: hours.end != null ? hours.end : HOURS_DEFAULT.end,
      text: hours.text || AFTER_HOURS_DEFAULT
    },
    // 库里还没 faq 文档时回显内置规则，运营才知道自己要改什么
    faq: ((faq && faq.rules) || []).length ? faq.rules : FAQ_DEFAULT,
    groupMap: (groupMap && groupMap.map) || GROUP_MAP_DEFAULT,
    groupCode: groupCode || {},
    groupIntro: groupIntro.text || GROUP_INTRO_DEFAULT,
    stats
  }
}

/**
 * 换群码：base64 → 云存储 → 更新 csConfig/group_code
 * ⚠️ 路径带时间戳而不是「固定文件名」：云存储同名覆盖虽然不会命中小程序本地缓存，
 *    但带时间戳能保证任何一层 CDN / 微信素材缓存都不会给出旧图（本项目已踩过同类坑）
 */
async function uploadGroupCode(group, base64) {
  const g = String(group || '').toUpperCase()
  if (['A', 'B', 'C'].indexOf(g) === -1) throw new Error('群标识必须是 A / B / C')
  if (!base64) throw new Error('缺少图片数据')
  const clean = String(base64).replace(/^data:image\/\w+;base64,/, '')
  const buf = Buffer.from(clean, 'base64')
  if (!buf.length) throw new Error('图片数据为空')
  // 微信客服临时素材有体积上限，控制在 1MB 内
  if (buf.length > 1024 * 1024) throw new Error('图片太大了，请压到 1MB 以内')

  const cloudPath = `cs/group-${g}-${stamp()}.png`
  const up = await withTimeout(
    cloud.uploadFile({ cloudPath, fileContent: buf }),
    20000, 'upload'
  )
  const fileID = up && up.fileID
  if (!fileID) throw new Error('上传到云存储失败')

  const cur = (await getConfig('group_code', {})) || {}
  const next = Object.assign({}, cur, {
    [g]: { fileID, updatedAt: db.serverDate() }
  })
  await setConfig('group_code', next)
  return { ok: true, group: g, fileID }
}

// ============ 内容审核（PRD《内容安全与风控》第 10、11 节） ============
// 全部复用本文件顶部的 checkOpenid + 口令两道鉴权，**不另起权限体系**

function tail(openid) {
  return '用户' + String(openid || '').slice(-4)
}

/** 待处理举报（按 postId 聚合：一条内容被几个人举报、都是什么原因）
 *  ⚠️ 昵称复用文件里已有的 namesOf（460 行附近），别再定义一份同名函数 */
async function listReports() {
  const r = await db.collection('reports')
    .where({ status: 'open' }).orderBy('createdAt', 'asc').limit(50).get()
  const byPost = {}
  ;(r.data || []).forEach((x) => {
    const k = x.postId
    if (!k) return
    if (!byPost[k]) {
      byPost[k] = {
        postId: k,
        petId: x.petId || '',
        petName: x.petName || '',
        authorOpenid: x.authorOpenid || '',
        // evidence 只存缩略图：不许在这个后台里展示/留存违规原图
        evidence: (x.evidence || []).slice(0, 3),
        reasons: [],
        count: 0,
        firstAt: x.createdAt || null
      }
    }
    byPost[k].reasons.push(x.reason)
    byPost[k].count++
  })
  const list = Object.keys(byPost).map((k) => byPost[k])
  const names = await namesOf(list.map((x) => x.authorOpenid))
  list.forEach((x) => { x.authorName = names[x.authorOpenid] || tail(x.authorOpenid) })
  return { ok: true, list }
}

/**
 * 处理一条举报
 * @param {string} postId
 * @param {'delete'|'ban'|'reject'} act
 *   delete 删内容（不封人）  ban 删内容 + 封禁作者（含历史下架）  reject 举报不成立（恢复）
 */
async function handleReport(postId, act, note, operator) {
  if (!postId) throw new Error('缺少 postId')
  const p = await db.collection('posts').doc(postId).get().catch(() => null)
  const doc = p && p.data
  if (!doc) throw new Error('记录不存在或已删除')

  const files = []
  ;((doc.images) || []).forEach((im) => {
    if (im && im.thumbID) files.push(im.thumbID)
    if (im && im.fileID) files.push(im.fileID)
  })

  let tookDown = 0
  let banned = false
  let deleted = false

  if (act === 'reject') {
    // 举报不成立：恢复原可见性（prevVisibility 是下架时存的原值）
    await db.collection('posts').doc(postId).update({
      data: {
        audit: 'ok',
        visibility: doc.prevVisibility || 'all',
        auditAt: db.serverDate(),
        auditNote: 'report-rejected'
      }
    })
  } else {
    // delete / ban：先删文件再删记录（顺序别反，否则留孤儿文件）
    if (files.length) {
      for (let i = 0; i < files.length; i += 50) {
        try { await cloud.deleteFile({ fileList: files.slice(i, i + 50) }) } catch (e) { /* 忽略 */ }
      }
    }
    await db.collection('posts').doc(postId).remove().catch(() => {})
    deleted = true
    if (act === 'ban' && doc.createdBy) {
      const r = await banUser(doc.createdBy, 'report', String(note || '').slice(0, 200), operator)
      tookDown = r.tookDown || 0
      banned = true
    }
  }

  // 这条内容的全部举报一起结案（留痕：谁处理的、备注）
  await db.collection('reports').where({ postId }).update({
    data: {
      status: act === 'reject' ? 'rejected' : 'resolved',
      handler: operator,
      handleAt: db.serverDate(),
      handleNote: String(note || '').slice(0, 200)
    }
  }).catch(() => {})

  return { ok: true, act, deleted, banned, tookDown }
}

/** 封禁：写 banned + 历史内容一并下架（先下架不清数据，留 7 天申诉期） */
async function banUser(openid, reason, note, operator) {
  const o = String(openid || '').trim()
  if (!o) throw new Error('缺少 openid')
  const rk = ['sec', 'report', 'manual'].indexOf(reason) >= 0 ? reason : 'manual'

  const ex = await db.collection('banned')
    .where({ openid: o, status: 'active' }).limit(1).get().catch(() => ({ data: [] }))
  if (ex.data && ex.data.length) return { ok: true, duplicated: true, tookDown: 0 }

  await db.collection('banned').add({
    data: {
      openid: o,
      reason: rk,
      note: String(note || '').slice(0, 200),
      operator: operator || '',
      bannedAt: db.serverDate(),
      status: 'active'
    }
  })

  let tookDown = 0
  try {
    const r = await db.collection('posts').where({ createdBy: o }).limit(1000).get()
    for (const p of (r.data || [])) {
      if (p.audit === 'blocked' && p.visibility === 'private') continue
      await db.collection('posts').doc(p._id).update({
        data: {
          prevVisibility: p.visibility || 'all',
          visibility: 'private',
          audit: 'blocked',
          auditAt: db.serverDate(),
          auditNote: '封禁连带下架'
        }
      })
      tookDown++
    }
  } catch (e) {
    console.error('[csAdmin] 封禁连带下架失败', e && e.message)
  }
  return { ok: true, tookDown }
}

/** 解封：status 置 lifted **留痕**，绝不物理删除 banned 记录 */
async function unbanUser(openid, note, operator) {
  const o = String(openid || '').trim()
  if (!o) throw new Error('缺少 openid')
  const r = await db.collection('banned').where({ openid: o, status: 'active' }).limit(10).get()
  if (!(r.data || []).length) return { ok: true, updated: 0 }
  for (const b of r.data) {
    await db.collection('banned').doc(b._id).update({
      data: {
        status: 'lifted',
        liftAt: db.serverDate(),
        liftBy: operator || '',
        liftNote: String(note || '').slice(0, 200)
      }
    })
  }
  return { ok: true, updated: r.data.length }
}

/**
 * 一键清空某用户的全部数据（隐私政策《注销账号》承诺的技术兜底，《个保法》第 47 条）
 *
 * 覆盖：业务数据 + 客服会话 + 订阅凭证 + 埋点 + 云存储里的图片文件
 * 刻意不清（都有保留理由）：
 *   banned / auditWhitelist —— 风控留痕，解封与申诉语义依赖历史记录；
 *   csConfig                —— 全局配置，不属于任何用户；
 *   adminLog                —— 清空操作自身的审计日志（删了就没人说得清删过什么）。
 *
 * ⚠️ 误触防护：confirm 必须逐字传「确认清空」，缺了直接拒绝，不做任何删除。
 * ⚠️ 级联边界：被清用户是宠物主人的话，petMembers 里其他成员的共享关系会随宠物一起消失
 *    （家庭共享场景极少，注销语义下可接受；真要多宠物协作时再拆）。
 */
const WIPE_CONFIRM_TEXT = '确认清空'
const WIPE_COLS = [
  // 业务数据（petData 写，createdBy / _openid 两种归属字段并存，三遍扫全兜住）
  'users', 'pets', 'petMembers', 'invites', 'events',
  'health', 'weights', 'daily', 'expenses', 'posts',
  // 订阅 / 客服 / 风控运行时
  'subTickets', 'csQuota', 'csMessages', 'csSessions', 'csOutbox', 'reports', 'rateLimit'
]

async function wipeUser(openid, confirm, operator) {
  const o = String(openid || '').trim()
  if (!o) return { ok: false, err: '缺少 openid' }
  if (String(confirm || '') !== WIPE_CONFIRM_TEXT) {
    return { ok: false, err: '缺少确认：confirm 必须逐字传「' + WIPE_CONFIRM_TEXT + '」' }
  }

  // ① 删文档之前先收集云存储文件引用（文档没了就再也找不到了）
  const fileIDs = []
  try {
    const pr = await db.collection('posts').where({ createdBy: o }).limit(1000).get()
    for (const p of (pr.data || [])) {
      for (const im of (p.images || [])) {
        if (im && im.fileID) fileIDs.push(im.fileID)
        if (im && im.thumbID) fileIDs.push(im.thumbID)
      }
    }
  } catch (e) { console.error('[csAdmin] wipe 收集帖子图片失败', e && e.message) }
  try {
    const ur = await db.collection('users').where({ _openid: o }).limit(1).get()
    const av = ur.data[0] && ur.data[0].settings && ur.data[0].settings.avatar
    if (av && String(av).indexOf('cloud://') === 0) fileIDs.push(av)
  } catch (e) { /* 头像多半是微信临时 URL，不是云存储 fileID，删不了也不报错 */ }
  try {
    const ptr = await db.collection('pets').where({ createdBy: o }).limit(100).get()
    for (const pet of (ptr.data || [])) {
      if (pet && pet.avatar && String(pet.avatar).indexOf('cloud://') === 0) fileIDs.push(pet.avatar)
    }
  } catch (e) { /* 同上 */ }
  if (fileIDs.length) {
    await cloud.deleteFile({ fileList: fileIDs }).catch((e) => {
      console.error('[csAdmin] wipe 删存储文件失败', e && e.message)
    })
  }

  // ② 三遍扫删除：_openid（客户端直写集合）/ createdBy（云函数写集合）/ openid（客服体系）
  //    字段在该集合里不存在 → 匹配 0 条，天然无害；集合没建 → catch 掉计 0
  const wiped = {}
  for (const col of WIPE_COLS) {
    let n = 0
    for (const f of ['_openid', 'createdBy', 'openid']) {
      try {
        const r = await db.collection(col).where({ [f]: o }).remove()
        n += (r.stats && r.stats.removed) || 0
      } catch (e) { /* 集合未建等 → 0 */ }
    }
    wiped[col] = n
  }

  // ③ 审计留痕：谁在什么时候清了谁、各删了多少（adminLog 集合没建也不阻断）
  await db.collection('adminLog').add({
    data: { action: 'wipeUser', target: o, operator: operator || '', wiped, files: fileIDs.length, at: db.serverDate() }
  }).catch(() => null)

  return { ok: true, wiped, files: fileIDs.length }
}

/* ---------- 运营数据看板（与 statDaily 云函数同源的聚合逻辑） ----------
   ⚠️ 同源约定：口径与 cloudfunctions/statDaily/index.js 完全一致，是同一份逻辑的两份拷贝
   （云函数之间无法共享代码文件）—— 改口径两处一起改。同款先例：FAQ 规则、事件白名单。 */

const STAT_RECORD_EVENTS = ['record_added', 'daily_added', 'expense_added']

/** 北京时间 dateStr（YYYY-MM-DD）→ 该自然日的 UTC 起止（库里 serverTs 是 UTC） */
function statDayRange(dateStr) {
  const p = String(dateStr || '').split('-').map(Number)
  const start = Date.UTC(p[0], p[1] - 1, p[2], 0, 0, 0) - 8 * 3600 * 1000
  return { start: new Date(start), end: new Date(start + 86400000) }
}

/** 当前时刻对应的北京时间日期串 / HH:mm */
function statCstParts(now) {
  const d = new Date((now || Date.now()) + 8 * 3600 * 1000)
  return { date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) }
}

/** 人数口径：按时间区间 + 事件过滤 → openid 去重计数 */
async function statCountUsers(range, extraMatch) {
  const r = await db.collection('events').aggregate()
    .match(Object.assign({ serverTs: _.gte(range.start).and(_.lt(range.end)) }, extraMatch || {}))
    .group({ _id: '$openid' })
    .count('n')
    .end()
  return (r.list && r.list[0] && r.list[0].n) || 0
}

async function statCountDocs(range, extraMatch) {
  const r = await db.collection('events')
    .where(Object.assign({ serverTs: _.gte(range.start).and(_.lt(range.end)) }, extraMatch || {}))
    .count()
  return r.total || 0
}

/** 一段时间的完整指标（历史日传入全天区间；今日实时传入截止当前的区间） */
async function statRange(range) {
  const dau = await statCountUsers(range)
  const launches = await statCountDocs(range, { event: 'app_launch' })
  const [newUsers, profileUpdated, petsCreated, recordsAdded, postsAdded] = await Promise.all([
    statCountUsers(range, { event: 'app_launch', 'props.isFirst': true }),
    statCountUsers(range, { event: 'profile_updated' }),
    statCountUsers(range, { event: 'pet_created' }),
    statCountUsers(range, { event: _.in(STAT_RECORD_EVENTS) }),
    statCountUsers(range, { event: 'post_added' })
  ])
  const sr = await db.collection('events').aggregate()
    .match({ serverTs: _.gte(range.start).and(_.lt(range.end)), event: 'app_launch' })
    .group({ _id: '$sId' })
    .count('n')
    .end()
  return {
    dau, newUsers, launches,
    sessions: (sr.list && sr.list[0] && sr.list[0].n) || 0,
    profileUpdated, petsCreated, recordsAdded, postsAdded
  }
}

/** dailyStats action 的数据组装：今天实时 + 历史 N-1 天（读 dailyStats） */
async function dailyStatsReport(days) {
  const n = Math.min(Math.max(Number(days) || 14, 1), 90)
  const now = Date.now()
  const tp = statCstParts(now)
  // 今日：从北京时间 0 点到当前时刻（⚠️ 区间终点必须用 end < now 的 Date，不能复用全天区间）
  const tr = statDayRange(tp.date)
  tr.end = new Date(now)
  const today = await statRange(tr)
  // 历史：dailyStats 逐日落库值（statDaily 云函数每天 01:10 产出）
  const hist = await db.collection('dailyStats')
    .where({ date: _.neq(tp.date) })
    .orderBy('date', 'desc').limit(n - 1).get().catch(() => ({ data: [] }))
  return {
    ok: true,
    today: Object.assign(today, { date: tp.date, asOf: tp.hhmm, live: true }),
    days: hist.data || []
  }
}

/**
 * 用户明细列表（「用户」页签）：谁最近来过、来了几次、用到了哪一步
 * 三条聚合管道 + users 表昵称头像，在 JS 里合并 —— 别想着一条管道干完，
 * openevents 的去重口径（sId 会话）和业务计数（按事件）没法在同一次 group 里算清
 * @returns {ok, list: [{openid, nickname, avatar, lastTs, todayOpens, sessions, pets, records, posts}]}
 */
async function userList(limitNum) {
  const n = Math.min(Math.max(Number(limitNum) || 50, 1), 200)
  const now = Date.now()
  const tp = statCstParts(now)
  const tr = statDayRange(tp.date)
  tr.end = new Date(now)

  // ① 会话数 + 最近活跃时间（两级 group：先 (openid,sId) 去重，再按 openid 汇总）
  const sess = await db.collection('events').aggregate()
    .group({ _id: { o: '$openid', s: '$sId' }, last: $.max('$serverTs') })
    .group({ _id: '$_id.o', sessions: $.sum(1), lastTs: $.max('$last') })
    .sort({ lastTs: -1 })
    .limit(n)
    .end()

  // ② 今日打开次数
  const tdy = await db.collection('events').aggregate()
    .match({ serverTs: _.gte(tr.start).and(_.lt(tr.end)), event: 'app_launch' })
    .group({ _id: '$openid', n: $.sum(1) })
    .end()

  // ③ 业务计数：建档 / 记录 / 发帖（条件求和，一次管道算完三个）
  const biz = await db.collection('events').aggregate()
    .match({ event: _.in(['pet_created'].concat(STAT_RECORD_EVENTS, ['post_added'])) })
    .group({
      _id: '$openid',
      pets: $.sum($.cond({ if: $.eq(['$event', 'pet_created']), then: 1, else: 0 })),
      records: $.sum($.cond({
        if: $.or([$.eq(['$event', 'record_added']), $.eq(['$event', 'daily_added']), $.eq(['$event', 'expense_added'])]),
        then: 1, else: 0
      })),
      posts: $.sum($.cond({ if: $.eq(['$event', 'post_added']), then: 1, else: 0 }))
    })
    .end()

  // ④ 昵称头像（users.settings 最新值；没设置过就是空 → 前端显示占位）
  const us = await db.collection('users')
    .field({ _openid: true, settings: true }).limit(1000).get().catch(() => ({ data: [] }))
  const uMap = {}
  ;(us.data || []).forEach((u) => {
    if (u && u._openid) uMap[u._openid] = u.settings || {}
  })

  const tMap = {}
  ;(tdy.list || []).forEach((x) => { tMap[x._id] = x.n })
  const bMap = {}
  ;(biz.list || []).forEach((x) => { bMap[x._id] = x })

  const list = (sess.list || []).map((x) => ({
    openid: x._id,
    nickname: uMap[x._id] && (uMap[x._id].nickname || ''),
    avatar: uMap[x._id] && (uMap[x._id].avatar || ''),
    lastTs: x.lastTs || '',
    todayOpens: tMap[x._id] || 0,
    sessions: x.sessions || 0,
    pets: (bMap[x._id] && bMap[x._id].pets) || 0,
    records: (bMap[x._id] && bMap[x._id].records) || 0,
    posts: (bMap[x._id] && bMap[x._id].posts) || 0
  }))
  return { ok: true, list }
}

/**
 * 单用户逐次打开记录（「用户」页签点某一行展开）
 * 口径与手动在控制台查 events 一致：app_launch 倒序，连续同 sId 合并为一次使用
 */
async function userVisits(openid) {
  const o = String(openid || '').trim()
  if (!o) return { ok: false, err: '缺少 openid' }
  const r = await db.collection('events')
    .where({ openid: o, event: 'app_launch' })
    .orderBy('serverTs', 'desc').limit(60).get()
  const visits = []
  ;(r.data || []).forEach((d) => {
    const prev = visits[visits.length - 1]
    // 冷启动只有 20 秒内且同 sId 才算同一次（快速退出重进），否则各自成行
    if (prev && prev.sId === d.sId) {
      prev.launches++
      return
    }
    visits.push({
      sId: d.sId || '',
      ts: d.serverTs || '',
      scene: d.scene || (d.props && d.props.scene) || 0,
      launches: 1
    })
  })
  return { ok: true, openid: o, list: visits.slice(0, 50) }
}

/** 申诉列表（posts.appeal.status = 'open'） */
async function listAppeals() {
  const r = await db.collection('posts')
    .where({ 'appeal.status': 'open' }).limit(50).get()
  const list = (r.data || []).map((p) => ({
    postId: p._id,
    petId: p.petId || '',
    authorOpenid: p.createdBy || '',
    content: String(p.content || '').slice(0, 60),
    // 只回缩略图给后台看，不回原图
    thumbs: ((p.images || []).map((im) => im && im.thumbID)).filter(Boolean).slice(0, 3),
    audit: p.audit || '',
    appealAt: (p.appeal && p.appeal.at) || null,
    appealNote: (p.appeal && p.appeal.note) || ''
  }))
  const names = await namesOf(list.map((x) => x.authorOpenid))
  list.forEach((x) => { x.authorName = names[x.authorOpenid] || tail(x.authorOpenid) })
  return { ok: true, list }
}

/**
 * 复核申诉
 * @param {boolean} pass 通过 = 恢复 + 把这张图写进白名单（后续不再复检）
 */
async function resolveAppeal(postId, pass, note, operator) {
  if (!postId) throw new Error('缺少 postId')
  const p = await db.collection('posts').doc(postId).get().catch(() => null)
  const doc = p && p.data
  if (!doc) throw new Error('记录不存在')

  let whitelisted = 0
  if (pass) {
    // 把这张图的**内容 md5** 写进白名单：用 thumbID 的话用户重发同图会换路径，永远命中不了
    const ids = ((doc.images || []).map((im) => im && (im.thumbID || im.fileID))).filter(Boolean)
    for (const fileID of ids) {
      try {
        const r = await cloud.downloadFile({ fileID })
        const buf = r && r.fileContent
        if (!buf || !buf.length) continue
        const key = crypto.createHash('md5').update(buf).digest('hex')
        const ex = await db.collection('auditWhitelist').where({ key }).limit(1).get().catch(() => ({ data: [] }))
        if (ex.data && ex.data.length) { whitelisted++; continue }
        await db.collection('auditWhitelist').add({
          data: { key, operator: operator || '', note: '申诉通过 ' + String(note || '').slice(0, 100), createdAt: db.serverDate() }
        })
        whitelisted++
      } catch (e) {
        console.warn('[csAdmin] 白名单写入失败', fileID, e && e.message)
      }
    }
  }

  await db.collection('posts').doc(postId).update({
    data: {
      audit: pass ? 'ok' : 'blocked',
      // 恢复原可见性（下架时存的原值；没有就按 all）
      visibility: pass ? (doc.prevVisibility || 'all') : (doc.visibility || 'private'),
      auditAt: db.serverDate(),
      auditNote: pass ? 'appeal-accepted' : 'appeal-rejected',
      appeal: {
        status: 'resolved',
        at: db.serverDate(),
        note: String(note || '').slice(0, 200),
        by: operator || '',
        pass: !!pass
      }
    }
  })
  return { ok: true, pass: !!pass, whitelisted }
}

/**
 * 口令失败限流（按 openid 记在 rateLimit 集合，key 加 csadmin_ 前缀与内容安全的风控 key 区分开）
 * 为什么必须做：csAdmin 上线后就是公网 API，口令可以被人拿着字典慢慢试；
 * 云函数实例是易失的，内存计数在多实例下形同虚设，所以必须落库。
 * ⚠️ 限流自身 fail-open：集合没建 / 查询报错时放行 —— 不能因为风控表缺失把管理员自己锁在门外。
 *    （代价：删掉 rateLimit 集合 = 限流失效，但鉴权本身不依赖它，两道闸都在限流前面。）
 */
const RL_COL = 'rateLimit'
const RL_KEY_PREFIX = 'csadmin_fail_'
const RL_MAX_FAILS = 5          // 10 分钟窗口内允许的口令失败次数
const RL_WIN_MS = 10 * 60 * 1000 // 达到上限后锁定时长（也是计数窗口）

async function rlBlocked(openid) {
  try {
    const r = await db.collection(RL_COL).where({ key: RL_KEY_PREFIX + openid }).limit(1).get()
    const d = (r.data || [])[0]
    return !!(d && d.until && Date.now() < d.until)
  } catch (e) {
    console.error('[csAdmin] 限流查询失败（fail-open 放行）', e && e.message)
    return false
  }
}

async function rlFail(openid) {
  const key = RL_KEY_PREFIX + openid
  const now = Date.now()
  try {
    const r = await db.collection(RL_COL).where({ key }).limit(1).get()
    const d = (r.data || [])[0]
    if (!d) {
      await db.collection(RL_COL).add({ data: { key, count: 1, since: now, until: 0 } })
      return
    }
    const inWin = now - (d.since || 0) < RL_WIN_MS
    const count = inWin ? (d.count || 0) + 1 : 1
    await db.collection(RL_COL).doc(d._id).update({
      data: {
        count,
        since: inWin ? d.since : now,
        // 达到上限 → 锁一个窗口期；期间 rlBlocked 会一直拦，窗口过后计数重新从 1 数
        until: count >= RL_MAX_FAILS ? now + RL_WIN_MS : 0
      }
    })
  } catch (e) {
    console.error('[csAdmin] 限流写入失败（fail-open 放行）', e && e.message)
  }
}

async function rlReset(openid) {
  try {
    await db.collection(RL_COL).where({ key: RL_KEY_PREFIX + openid }).remove()
  } catch (e) { /* 清理失败不影响主流程 */ }
}

/**
 * 账号白名单判断
 * @returns {{allowed:boolean, locked:boolean, myOpenid:string, count:number}}
 *   locked = 白名单是否已配置并生效（false 表示「未限制」）
 *   count  = 白名单里配了几个 openid（只回数量，不回内容）
 *            —— 用来区分「环境变量没读到」和「读到了但没有我」，两者处置完全不同
 */
function checkOpenid() {
  const ctx = cloud.getWXContext() || {}
  const my = String(ctx.OPENID || '').trim()
  const raw = String(process.env.CS_ADMIN_OPENIDS || '').trim()
  if (!raw) return { allowed: true, locked: false, myOpenid: my, count: 0 }
  // ⚠️ 逐段 trim：从控制台复制时很容易带空格，不 trim 会永远匹配不上
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return { allowed: list.indexOf(my) !== -1, locked: true, myOpenid: my, count: list.length }
}

exports.main = async (event) => {
  event = event || {}
  const t0 = Date.now()
  const expect = String(process.env.CS_ADMIN_TOKEN || '').trim()
  const token = String(event.token || '').trim()

  // ⚠️ whoami 是「拿自己 openid」的入口，必须在口令校验之前放行，
  //    否则第一次永远不知道该把哪个 openid 填进白名单
  if (String(event.action || '') === 'whoami') {
    const g = checkOpenid()
    // ⚠️ 信息最小化：只回 locked + myOpenid。
    //    isAdmin / adminCount 不回 —— 前端的权限探测改走 probe（有过闸），
    //    白名单人数属于侦查价值最高的字段（帮攻击者确认防御规模），彻底去掉
    return {
      ok: true,
      build: BUILD,
      locked: g.locked,
      // ⚠️ 始终回显调用者自己的 openid（不是别人的，不涉及越权）：
      //    锁了之后也要能回显，否则「入口没出来」时无从判断是不是填错了 openid
      myOpenid: g.myOpenid
    }
  }

  // probe：给前端显隐入口用的权限探测。有过闸（未配白名单时与旧行为一致视为可见，
  // 进后台仍需口令），只回一个布尔 —— 身份判断在服务端，前端显隐只是 UI 不是边界
  if (String(event.action || '') === 'probe') {
    const g = checkOpenid()
    if (!g.locked) return { ok: true, locked: false, build: BUILD }
    return { ok: g.allowed, locked: true, build: BUILD }
  }

  const gate = checkOpenid()

  // 口令失败限流：5 次 / 10 分钟，超了锁 10 分钟（按 openid 记库，多实例下也生效）
  if (await rlBlocked(gate.myOpenid)) {
    return { ok: false, err: '尝试次数过多，请 10 分钟后再试', build: BUILD }
  }

  /**
   * 口令策略（按白名单是否已配置分两阶段）：
   *   ① 还没配 CS_ADMIN_OPENIDS → 白名单是唯一屏障，口令**必填**（fail-close）
   *   ② 已配 CS_ADMIN_OPENIDS   → 身份由 openid 保证，口令**变成可选**：
   *      不填也能进（省得每次进来都输一遍），填了就顺带校验
   */
  if (!gate.locked) {
    if (!expect) {
      console.error('[csAdmin] 未配置 CS_ADMIN_TOKEN，且白名单也未配置，拒绝访问')
      return { ok: false, err: '服务端未配置运营口令（CS_ADMIN_TOKEN）', build: BUILD }
    }
    if (token !== expect) {
      await rlFail(gate.myOpenid)
      console.warn('[csAdmin] 口令不匹配，拒绝访问')
      return { ok: false, err: '口令不对', build: BUILD }
    }
  } else if (expect && token && token !== expect) {
    await rlFail(gate.myOpenid)
    return { ok: false, err: '口令不对', build: BUILD }
  }

  if (!gate.allowed) {
    // 只打尾号：openid 属于敏感信息，日志里不落全量
    console.warn('[csAdmin] openid 不在白名单，拒绝访问 尾号=', String(gate.myOpenid).slice(-6))
    return { ok: false, err: '这个微信账号没有运营权限', build: BUILD }
  }

  // 走到这里 = 鉴权全过，清掉失败计数（下次从 0 数起）
  await rlReset(gate.myOpenid)

  try {
    const action = String(event.action || 'overview')
    if (action === 'overview') return Object.assign(await overview(), { cost: Date.now() - t0 })
    if (action === 'listSessions') return Object.assign(await listSessions(), { cost: Date.now() - t0 })
    if (action === 'listMessages') return Object.assign(await listMessages(event.openid), { cost: Date.now() - t0 })
    if (action === 'selfcheck') return Object.assign(await selfcheck(), { cost: Date.now() - t0 })
    if (action === 'markRead') return Object.assign(await markRead(event.openid), { cost: Date.now() - t0 })
    if (action === 'reply') return Object.assign(await reply(event.openid, event.text), { cost: Date.now() - t0 })
    if (action === 'setWelcome') {
      await setConfig('welcome', { text: String(event.text || '') })
      return { ok: true, cost: Date.now() - t0 }
    }
    if (action === 'setHours') {
      await setConfig('hours', {
        start: Number(event.start),
        end: Number(event.end),
        text: String(event.text || '')
      })
      return { ok: true, cost: Date.now() - t0 }
    }
    if (action === 'setGroupMap') {
      await setConfig('group_map', { map: event.map || {} })
      return { ok: true, cost: Date.now() - t0 }
    }
    if (action === 'setGroupCode') {
      const r = await uploadGroupCode(event.group, event.base64)
      return Object.assign(r, { cost: Date.now() - t0 })
    }

    // ---- 内容审核（PRD《内容安全与风控》第 10 节）----
    // ⚠️ 这些 action 全部走上面同一道 checkOpenid + 口令鉴权，没有独立入口
    //    （服务端必须校验，不能只靠前端隐藏后台入口）
    if (action === 'listReports') {
      return Object.assign(await listReports(), { cost: Date.now() - t0 })
    }
    if (action === 'handleReport') {
      const r = await handleReport(event.postId, event.act, event.note, gate.myOpenid)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'banUser') {
      const r = await banUser(event.openid, event.reason, event.note, gate.myOpenid)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'unbanUser') {
      const r = await unbanUser(event.openid, event.note, gate.myOpenid)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'wipeUser') {
      const r = await wipeUser(event.openid, event.confirm, gate.myOpenid)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'dailyStats') {
      const r = await dailyStatsReport(event.days)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'userList') {
      const r = await userList(event.limit)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'userVisits') {
      const r = await userVisits(event.openid)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    if (action === 'listAppeals') {
      return Object.assign(await listAppeals(), { cost: Date.now() - t0 })
    }
    if (action === 'resolveAppeal') {
      const r = await resolveAppeal(event.postId, event.pass, event.note, gate.myOpenid)
      return Object.assign(r, { cost: Date.now() - t0 })
    }
    return { ok: false, err: '未知 action: ' + action, build: BUILD }
  } catch (e) {
    console.error('[csAdmin] 执行异常', e && e.message)
    return { ok: false, err: e && e.message, build: BUILD, cost: Date.now() - t0 }
  }
}
