/**
 * petData · 宠物数据统一读写入口
 *
 * 收口原因：1 期靠「仅创建者可读写」+ _openid 隔离，被邀请人 openid 不同读不到数据。
 *          2 期把 pets/health/weights/daily/expenses 五集合权限切「仅管理端可读写」，
 *          所有读写收口到本云函数，在云函数里查 petMembers(petId,openid,status=active) 校验。
 *
 * 权限规则（PRD 2 节）：
 * - owner(1)：增删改全部记录 + 改档案 + 删宠物 + 邀请/移除成员/撤销邀请
 * - member(≤4)：可记可改可删**自己记的**（别人记的只能看），不能改档案/删宠物/移除任何人
 * - 上限 5 人(含 owner)，超过 20 只宠物(各 role)拒绝
 *
 * v2.1 变更（时间线图文与相册）：
 * - 新增 posts 集合的 listPosts / addPost / removePost（图文与相册共用一份数据）
 * - removeRecord / updateRecord 收紧为「作者本人 + owner」（原「是成员就能删任何人」）
 * - 新增 checkText：文案内容安全（P0 同步拦截）
 * - posts 集合权限需设为「所有用户不可读写」（与控制台里其他五集合一致）
 * - 环境变量：MINI_APPID / MINI_APPSECRET（仅 checkText 的 HTTPS 兜底用；不配则检测服务不可用，
 *   发图文会以 audit:'unchecked' 放行并打 warn，上线前请配齐）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
/**
 * 内容安全与风控（PRD《内容安全与风控》v1.0）
 * ⚠️ 必须在 cloud.init() **之后** require：sec.js 自己不做 init，用的是这里传进去的 cloud / db
 */
const sec = require('./sec')(cloud, db)

const BUILD = '20261026-sec'

const MAX_PETS = 20
const MAX_MEMBERS = 5
const INVITE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * 邀请去抖窗口：微信转发面板每次打开都会调 createInvite，且没有「用户是否真的发出去」的回调，
 * 于是「点一下又取消、再点一下」就会留下多条待接受邀请。窗口内的重复请求复用同一条。
 * 30s 是刻意的：连发两个人（选会话→发送→返回→再点邀请）正常都超过 30s，不会被误合并。
 */
const INVITE_REUSE_MS = 30 * 1000
const RECORD_COLS = ['health', 'weights', 'daily', 'expenses']
/**
 * 图文集合（PRD v2.1 6.1）：故意**不**并入 RECORD_COLS。
 * RECORD_COLS 是 addRecord/listBy/... 的白名单，而 addRecord 会被前端塞进 50 条离线写队列；
 * 图文的图片必须先上传拿 fileID，离线状态下做不到 → 单独 3 个 action（listPosts/addPost/removePost）。
 */
const POST_COL = 'posts'
const MAX_POST_IMAGES = 9
const MAX_POST_TEXT = 200
// ============ 通用 ============

async function getMember(petId, openid) {
  const r = await db.collection('petMembers')
    .where({ petId, _openid: openid, status: 'active' })
    .limit(1).get()
  return r.data[0] || null
}

async function getMyMemberships(openid) {
  const r = await db.collection('petMembers')
    .where({ _openid: openid, status: 'active' })
    .limit(100).get()
  return r.data
}

async function getInvite(inviteId) {
  const r = await db.collection('invites').where({ inviteId }).limit(1).get()
  return r.data[0] || null
}

/** 同步宠物的 memberCount 冗余字段 */
async function syncMemberCount(petId) {
  const c = await db.collection('petMembers').where({ petId, status: 'active' }).count()
  await db.collection('pets').doc(petId).update({
    data: { memberCount: c.total, updatedAt: db.serverDate() }
  })
  return c.total
}

/** 宠物档案可更新字段白名单（防篡改 ownerOpenid/memberCount 等） */
function filterPetData(data) {
  if (!data || typeof data !== 'object') return {}
  const KEYS = [
    'name', 'species', 'weightUnit', 'breed', 'gender', 'weight',
    // avatarSmall：上传头像时顺带生成的小图档（长边 200），供 88rpx 以下的头像位使用
    'birthday', 'adoptDay', 'avatar', 'avatarSmall', 'pedigree', 'updatedAt',
    // 是否绝育（neutered）：取值见 utils/config.js 的 NEUTER_OPTIONS
    // ⚠️ 新增档案字段必须同步这里，否则前端写得再全也会被静默丢弃（写不进库且无任何报错）
    'neutered'
  ]
  const out = {}
  KEYS.forEach(k => { if (k in data) out[k] = data[k] })
  return out
}

/**
 * 记录的作者判定（PRD v2.1 6.2 / 附 B 2b）：作者本人 + owner 才有权删/改。
 *
 * ⚠️ 存量数据兜底必须留着：一期是「客户端直连写库」，记录里只有自动注入的 `_openid`，
 *    没有 `createdBy`；二期收口后服务端才补 `createdBy`。只认 `createdBy` 的话，
 *    收口前的老疫苗/体重/日常记录对谁都不是「作者本人」→ 连自己记的也删不掉。
 */
function isAuthorOrOwner(doc, openid, member) {
  if (!doc) return false
  if (member && member.role === 'owner') return true
  if (doc.createdBy) return doc.createdBy === openid
  if (doc._openid) return doc._openid === openid
  // 两个字段都没有（理论上不该出现）：只有 owner 能动
  return false
}

/** 读单条记录；不存在时返回 null（不用异常控制流程，云开发 doc().get() 缺失会抛） */
async function getDoc(col, id) {
  try {
    const r = await db.collection(col).doc(id).get()
    return r.data || null
  } catch (e) {
    return null
  }
}

/** 宠物成员 openid → 最新昵称头像（图文署名用；失败降级为空，不影响主数据） */
async function memberProfiles(petId) {
  const out = {}
  try {
    const r = await db.collection('petMembers')
      .where({ petId, status: 'active' }).limit(100).get()
    const openids = r.data.map(x => x._openid).filter(Boolean)
    r.data.forEach(x => {
      out[x._openid] = { nickname: x.nickname || '', avatar: x.avatar || '' }
    })
    if (openids.length) {
      const us = await db.collection('users')
        .where({ _openid: _.in(openids) }).limit(100).get()
      us.data.forEach(u => {
        const s = u && u.settings
        if (!s || !out[u._openid]) return
        if (s.nickname) out[u._openid].nickname = s.nickname
        if (s.avatar) out[u._openid].avatar = s.avatar
      })
    }
  } catch (e) { /* 忽略：署名留空，前端自然不渲染 */ }
  return out
}

// ============ pets ============

async function handleListPets(openid) {
  const members = await getMyMemberships(openid)
  if (!members.length) return { errCode: 0, data: [] }
  const petIds = members.map(m => m.petId)
  const pets = []
  for (let i = 0; i < petIds.length; i += 20) {
    const sub = petIds.slice(i, i + 20)
    const r = await db.collection('pets').where({ _id: _.in(sub) }).get()
    pets.push(...r.data)
  }
  // 按 createdAt 升序（与 1 期一致）
  pets.sort((a, b) => {
    const ta = (a.createdAt && typeof a.createdAt.getTime === 'function') ? a.createdAt.getTime() : 0
    const tb = (b.createdAt && typeof b.createdAt.getTime === 'function') ? b.createdAt.getTime() : 0
    return ta - tb
  })
  // 标注当前用户的角色与通知开关
  const byPet = {}
  members.forEach(m => { byPet[m.petId] = m })
  const out = pets.map(p => {
    const m = byPet[p._id]
    return { ...p, myRole: m ? m.role : 'member', myNotify: m ? !!m.notify : false }
  })
  return { errCode: 0, data: out }
}

async function handleAddPet(openid, data) {
  // 宠物上限（owner + member 的总数）
  const members = await getMyMemberships(openid)
  if (members.length >= MAX_PETS) return { errCode: 100, errMsg: '最多 ' + MAX_PETS + ' 只宠物' }

  // 取用户昵称头像（「我的」页可选设置），供成员列表署名展示
  let nickname = ''
  let avatar = ''
  try {
    const u = await db.collection('users').where({ _openid: openid }).limit(1).get()
    if (u.data[0] && u.data[0].settings) {
      nickname = u.data[0].settings.nickname || ''
      avatar = u.data[0].settings.avatar || ''
    }
  } catch (e) { /* 忽略 */ }

  const r = await db.collection('pets').add({
    data: {
      ...filterPetData(data),
      ownerOpenid: openid,
      memberCount: 1,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })
  const petId = r._id

  // 补一条 owner 成员记录
  await db.collection('petMembers').add({
    data: {
      petId,
      _openid: openid,
      role: 'owner',
      status: 'active',
      notify: true,
      nickname,
      avatar,
      joinedAt: db.serverDate(),
      invitedBy: ''
    }
  })

  return { errCode: 0, _id: petId }
}

async function handleUpdatePet(openid, petId, data) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  if (m.role !== 'owner') return { errCode: 403, errMsg: '仅创建者可编辑档案' }

  await db.collection('pets').doc(petId).update({
    data: { ...filterPetData(data), updatedAt: db.serverDate() }
  })
  return { errCode: 0 }
}

// ============ 记录 ============

async function handleListBy(openid, col, petId) {
  if (!RECORD_COLS.includes(col)) return { errCode: 1, errMsg: '非法集合: ' + col }
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权访问' }

  const r = await db.collection(col).where({ petId }).limit(1000).get()
  r.data.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  return { errCode: 0, data: r.data }
}

/**
 * 记录字段白名单（P1 安全加固）
 * addRecord 会被离线写队列重放，上线后更是任何拿到小程序包的人都能直接调云函数，
 * 不做白名单时入参里多出来的字段会原样进库（往数据里塞脏字段、污染读端逻辑）。
 * ⚠️ 新增字段：先在这里登记，再改前端 —— 白名单外的字段会被**静默丢弃**（不报错，
 *    老版本前端多塞的字段自然淘汰，不会让旧包保存失败）。
 */
const RECORD_FIELDS = {
  health: ['type', 'name', 'dose', 'date', 'nextDate', 'remind', 'note', 'cost',
    'reminded', 'remindFailed', 'authCount'],
  weights: ['date', 'value', 'note'],
  daily: ['tag', 'tagName', 'date', 'note', 'createdAtLocal'],
  expenses: ['amount', 'category', 'date', 'note', 'sourceType', 'sourceId']
}

async function handleAddRecord(openid, col, petId, data) {
  if (!RECORD_COLS.includes(col)) return { errCode: 1, errMsg: '非法集合: ' + col }
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }

  const allow = RECORD_FIELDS[col] || []
  const src = data || {}
  // petId / createdBy 一律以服务端视角覆盖（petId 来自路由参数、openid 来自微信上下文，都不可伪造）
  const body = { petId, createdBy: openid }
  for (const k of allow) {
    if (src[k] !== undefined) body[k] = src[k]
  }
  const r = await db.collection(col).add({ data: body })
  return { errCode: 0, _id: r._id }
}

async function handleUpdateRecord(openid, col, petId, id, data) {
  if (!RECORD_COLS.includes(col)) return { errCode: 1, errMsg: '非法集合: ' + col }
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }

  // ⚠️ 作者校验必须用**库里的** createdBy：入参里的 createdBy 会被下面剥离，
  //    而且前端本来就不该有机会通过改 createdBy 把别人的记录「变成自己的」
  const doc = await getDoc(col, id)
  if (!doc) return { errCode: 404, errMsg: '记录不存在或已删除' }
  if (doc.petId && doc.petId !== petId) return { errCode: 404, errMsg: '记录不存在' }
  if (!isAuthorOrOwner(doc, openid, m)) {
    return { errCode: 403, errMsg: '只能修改自己记录的内容' }
  }

  const { _id, _openid, petId: _p, createdBy, ...safe } = data || {}
  await db.collection(col).doc(id).update({ data: safe })
  return { errCode: 0 }
}

async function handleRemoveRecord(openid, col, petId, id) {
  if (!RECORD_COLS.includes(col)) return { errCode: 1, errMsg: '非法集合: ' + col }
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }

  const doc = await getDoc(col, id)
  // 记录已经没了：幂等返回成功。弱网重试 / 两端同时删都会走到这里，
  // 回 404 会让队列把它当失败反复重试，最后进死信区（用户看到「1 条同步失败」）
  if (!doc) return { errCode: 0, gone: true }
  if (doc.petId && doc.petId !== petId) return { errCode: 404, errMsg: '记录不存在' }
  if (!isAuthorOrOwner(doc, openid, m)) {
    return { errCode: 403, errMsg: '只能删除自己记录的内容' }
  }

  await db.collection(col).doc(id).remove()
  return { errCode: 0 }
}

async function handleListExpensesMonth(openid, petIdOrAll, start, end) {
  if (petIdOrAll === 'all') {
    // 汇总：当前用户参与的所有宠物的花销
    const members = await getMyMemberships(openid)
    const petIds = members.map(m => m.petId)
    if (!petIds.length) return { errCode: 0, data: [] }
    const where = { petId: _.in(petIds), date: _.gte(start).and(_.lt(end)) }
    const r = await db.collection('expenses').where(where).orderBy('date', 'desc').limit(1000).get()
    return { errCode: 0, data: r.data }
  }
  // 单只宠物
  const m = await getMember(petIdOrAll, openid)
  if (!m) return { errCode: 403, errMsg: '无权访问' }

  const r = await db.collection('expenses')
    .where({ petId: petIdOrAll, date: _.gte(start).and(_.lt(end)) })
    .orderBy('date', 'desc').limit(1000).get()
  return { errCode: 0, data: r.data }
}

// ============ 图文 / 相册（PRD v2.1） ============

/** 图片数组规整：服务端再兜一次上限，只留必要字段（防前端塞进任意字段污染库） */
function normImages(arr) {
  return (Array.isArray(arr) ? arr : [])
    .slice(0, MAX_POST_IMAGES)
    .map(im => ({
      fileID: String((im && im.fileID) || ''),
      thumbID: String((im && im.thumbID) || ''),
      w: Number(im && im.w) || 0,
      h: Number(im && im.h) || 0
    }))
    .filter(im => !!im.fileID)
}

/** 可见范围写死枚举：'all'（默认，全体成员可见）| 'private'（仅作者本人）。不透传前端值 */
function normVisibility(v) {
  return v === 'private' ? 'private' : 'all'
}

/** 'YYYY-MM-DD' 兜底成今天。云函数容器是 UTC，必须 +8h 才是北京时间口径 */
function normDate(v) {
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const p = n => (n < 10 ? '0' + n : '' + n)
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/**
 * 列出某宠物的图文（时间线 + 相册共用同一份数据，不新建相册集合）
 * ⚠️ 可见范围必须在这里过滤：漏了 = 私密内容被所有成员看到，是事故。
 *    `_.neq('private')` 天然匹配「字段不存在」的文档，老数据不用洗。
 * ⚠️ 但 `_.neq` 只能用在**顶层字段**上，不能塞进 `$or` 子条件（见函数内注释）。
 */
async function handleListPosts(openid, petId) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权访问' }

  /**
   * ⚠️ 血案复盘：这里**不能**写回
   *     `where({ petId, $or: [{ visibility: _.neq('private') }, { createdBy: openid }] })`
   *     云开发对「`$or` 子条件里嵌套查询指令（_.neq）」的序列化不可靠，实测结果是
   *     **一条都匹配不上**（owner 的 createdBy ≠ 成员的，第一个分支再失效 → 0 条），
   *     表现就是「成员发了共享可见的图文，owner 永远看不到」。
   *
   * 改成两段查询 + 内存合并：
   *   A. 非私密（全体成员可见）        → 顶层字段 + _.neq，行为可预期
   *   B. 我自己的私密内容（只我可见）  → 精确等值，与 A 不重叠
   * 每段都能吃到索引，且语义一眼可读。
   */
  const ts = (p) => (p.createdAt && typeof p.createdAt.getTime === 'function') ? p.createdAt.getTime() : 0
  const [pubR, ownR] = await Promise.all([
    db.collection(POST_COL).where({ petId, visibility: _.neq('private') })
      .orderBy('createdAt', 'desc').limit(1000).get().catch(() => ({ data: [] })),
    db.collection(POST_COL).where({ petId, createdBy: openid, visibility: 'private' })
      .orderBy('createdAt', 'desc').limit(1000).get().catch(() => ({ data: [] }))
  ])

  const seen = {}
  const list = []
  pubR.data.concat(ownR.data).forEach((p) => {
    if (!p || !p._id || seen[p._id]) return
    seen[p._id] = 1
    list.push(p)
  })
  list.sort((a, b) => ts(b) - ts(a))
  const r = { data: list }

  /**
   * 排障诊断（只在「一条都没查到」时才会跑，正常路径零额外开销）
   *
   * 二分点：
   *   total > 0  → 记录存在，是被可见性/作者条件挡掉了（visibility 字段不对）
   *   total === 0 → 这个 petId 下压根没有 posts
   *                 （多半是：写入没成功、或两人看到的不是同一只宠物 / petId 不一致）
   */
  let diag = null
  if (!r.data.length) {
    const c = await db.collection(POST_COL).where({ petId }).count().catch(() => null)
    // 顺手把实际文档的关键字段捞出来：一眼看出是 visibility 不对、还是 createdBy 不对
    const raw = await db.collection(POST_COL).where({ petId }).limit(20).get().catch(() => ({ data: [] }))
    diag = {
      petId,
      role: m.role,
      openidTail: String(openid).slice(-6),
      // totalAny > 0 但 filtered = 0 → 可见性/作者条件把记录挡掉了
      totalAny: c ? c.total : -1,
      docs: (raw.data || []).map((p) => ({
        idTail: String(p._id).slice(-6),
        vis: p.visibility,          // undefined = 字段缺失
        byTail: String(p.createdBy || '').slice(-6)
      }))
    }
    console.error('[petData] listPosts 返回 0 条', JSON.stringify(diag))
  }

  // 作者署名：只有「别人发的」才需要，单用户宠物直接跳过 users 查询
  const needName = r.data.some(p => p.createdBy && p.createdBy !== openid)
  const peers = needName ? await memberProfiles(petId) : {}
  const data = r.data.map(p => {
    const out = Object.assign({}, p)
    out.canDelete = isAuthorOrOwner(p, openid, m)
    // ⚠️ createdAt 是 serverDate，回到前端会被序列化（不是 Date 实例），
    //    额外回一个数值毫秒给前端做「今天 09:20」的时间展示与就地插入排序
    out.createdAtMs = (p.createdAt && typeof p.createdAt.getTime === 'function') ? p.createdAt.getTime() : 0
    if (p.createdBy && p.createdBy !== openid) {
      const pr = peers[p.createdBy] || {}
      out.authorName = pr.nickname || ''
      out.authorAvatar = pr.avatar || ''
    }
    return out
  })
  return { errCode: 0, data, myRole: m.role, diag }
}

/**
 * 发布图文（唯一写入口，所有风控闸门都挂在这）
 *
 * 顺序：封禁 → 频率/总量 → 文案+图片检测 → 入库 → 计数
 * ⚠️ 计数必须在入库**之后**：被 reject 的不该占用额度（否则拦一次就少一次机会）
 */
async function handleAddPost(openid, petId, data) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }

  // ① 封禁（入口层已拦一次，这里是双保险：addPost 是唯一写入口，不能只靠入口）
  const ban = await sec.isBanned(openid)
  if (ban) return { errCode: 403, errMsg: '账号已被限制发布', banned: true, banReason: ban.reason || '' }

  const d = data || {}
  const content = String(d.content || '').trim().slice(0, MAX_POST_TEXT)
  const images = normImages(d.images)
  // 纯图或纯文都能发，但不能两者皆空（空卡片在时间线上没有任何信息量）
  if (!content && !images.length) return { errCode: 104, errMsg: '写点什么，或者选一张照片' }

  // ② 频率 / 总量（防「被当免费图床」，成本最低收益最高的一层）
  const rate = await sec.checkRate(openid, images.length)
  if (!rate.ok) {
    return { errCode: rate.code === 'total' ? 106 : 105, errMsg: rate.msg, limit: rate.code }
  }

  // ③ 内容安全（fail-open：只有 87014 算违规，超时/报错一律放行 + pending）
  let audit = 'ok'
  let auditNote = ''
  try {
    const r = await sec.checkBeforePublish(openid, content, images)
    if (r.result === 'reject') {
      // ⚠️ 红线第 2 条：图是先上传再检测的，拦下来必须把文件全删掉，不留孤儿文件
      await sec.deleteFiles(sec.postFiles({ images }))
      console.warn('[petData] addPost 被安全检测拒绝', JSON.stringify({
        by: String(openid).slice(-6), target: r.target, imgs: images.length
      }))
      return { errCode: 107, errMsg: '这条内容可能不适合发布，换一张试试', reject: true, target: r.target }
    }
    if (r.result === 'pending') {
      audit = 'pending'
      auditNote = String(r.note || '').slice(0, 120)
    }
    // 埋点由前端上报（云函数里直接写 events 会绕过 track 的白名单校验），
    // 这里只把结果回传，前端拿 audit 去打 sec_checked
  } catch (e) {
    // 检测链路本身炸了也不能挡住用户记录 —— 记 pending，交给 secScan 补
    console.error('[petData] addPost 安全检测异常，按 pending 放行', e && e.message)
    audit = 'pending'
    auditNote = 'exception'
  }

  const body = {
    petId,
    createdBy: openid,
    // 显式写一份：云函数（管理端）写入不会自动注入 _openid
    _openid: openid,
    content,
    images,
    visibility: normVisibility(d.visibility),
    date: normDate(d.date),
    // 内容安全（PRD 风控 6.1）：ok 已过 / pending 待巡检 / blocked 已下架
    // ⚠️ 前端传的 'unchecked' 统一收敛成 'pending'：语义一样（都没检测），少一个枚举值
    audit,
    auditAt: db.serverDate(),
    auditNote,
    /** 巡检重试次数：连续 3 次仍 pending 就收敛成 ok，别无限重复扫 */
    auditTries: 0,
    appeal: null,
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  }
  const r = await db.collection(POST_COL).add({ data: body })

  // ④ 计数（发布成功后才自增）
  await sec.bumpRate(openid, images.length)

  // 排障信标：共享场景「owner 看不到成员发的图文」时，拿这里的 petId 与 owner 侧查询的 petId 对比
  console.log('[petData] addPost 写入成功', JSON.stringify({
    _id: r._id, petId, by: String(openid).slice(-6), visibility: body.visibility,
    imgs: images.length, audit
  }))
  // 云端 createdAt 是 serverDate，回一个本地毫秒给前端做「就地插入」排序用
  return { errCode: 0, _id: r._id, date: body.date, createdAt: Date.now(), audit }
}

/**
 * 删除图文：先删云存储文件（thumb + full 都删），再删记录。
 * ⚠️ 顺序别反：只删库会留下永远删不掉（也没人知道）的孤儿文件，持续占容量。
 * ⚠️ 必须用**管理端** cloud.deleteFile：前端 wx.cloud.deleteFile 只能删自己上传的文件，
 *    owner 删 member 发的图会静默失败。
 */
async function handleRemovePost(openid, petId, id) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }

  const p = await getDoc(POST_COL, id)
  if (!p) return { errCode: 0, gone: true }
  if (p.petId && p.petId !== petId) return { errCode: 404, errMsg: '记录不存在' }
  if (!isAuthorOrOwner(p, openid, m)) {
    return { errCode: 403, errMsg: '只能删除自己记录的内容' }
  }

  const files = []
  ;(p.images || []).forEach(im => {
    if (im && im.thumbID) files.push(im.thumbID)
    if (im && im.fileID) files.push(im.fileID)
  })
  let fileFailed = 0
  for (let i = 0; i < files.length; i += 50) {   // deleteFile 单次上限 50 个
    try {
      await cloud.deleteFile({ fileList: files.slice(i, i + 50) })
    } catch (e) {
      fileFailed += Math.min(50, files.length - i)
      console.error('[petData] deleteFile 失败（记录照删，文件留待人工清理）', e)
    }
  }
  await db.collection(POST_COL).doc(id).remove()
  return { errCode: 0, removedFiles: files.length - fileFailed, fileFailed }
}

// ============ 举报 / 申诉（PRD《内容安全与风控》第 10、11 节） ============

const REPORT_REASONS = ['porn', 'violence', 'illegal', 'abuse', 'other']
/**
 * 下架阈值：**2 个不同举报人**，或 **owner 单人**举报。
 * ⚠️ 与 PRD 原文（单人即下架）不同，已与产品确认：
 *    共享宠物只有 2-5 个成员，单人举报即下架是现成的攻击面（一人不爽就能把对方内容一键干掉，
 *    而运营不在线时那条内容要躺很久）。真实违规在小圈子里很快会有第二个人。
 */
const REPORT_TAKE_DOWN_DISTINCT = 2

async function handleReportPost(openid, petId, id, reason) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  const p = await getDoc(POST_COL, id)
  if (!p || (p.petId && p.petId !== petId)) return { errCode: 404, errMsg: '记录不存在' }
  if ((p.createdBy || p._openid) === openid) return { errCode: 108, errMsg: '不能举报自己发布的内容' }

  const rk = REPORT_REASONS.indexOf(reason) >= 0 ? reason : 'other'

  // 幂等：同一个人对同一条只记一次（重复提交不该刷高「举报人数」）
  const dup = await db.collection('reports')
    .where({ postId: id, reporterOpenid: openid }).limit(1).get().catch(() => ({ data: [] }))
  if (dup.data && dup.data.length) return { errCode: 0, duplicated: true, takenDown: false }

  let petName = ''
  try {
    const pr = await db.collection('pets').doc(petId).get()
    petName = (pr.data && pr.data.name) || ''
  } catch (e) { /* 名字拿不到不影响举报 */ }

  await db.collection('reports').add({
    data: {
      postId: id,
      petId,
      petName,
      reporterOpenid: openid,
      authorOpenid: p.createdBy || '',
      // evidence 只存缩略图：不许过度留存违规原图，避免我们自己变成「存储违规内容」的一方
      evidence: ((p.images || []).map((im) => im && im.thumbID)).filter(Boolean).slice(0, 3),
      reason: rk,
      status: 'open',
      createdAt: db.serverDate()
    }
  })

  const rs = await db.collection('reports')
    .where({ postId: id }).limit(100).get().catch(() => ({ data: [] }))
  const seen = {}
  ;(rs.data || []).forEach((x) => { if (x.reporterOpenid) seen[x.reporterOpenid] = 1 })
  const distinct = Object.keys(seen).length
  const takenDown = m.role === 'owner' || distinct >= REPORT_TAKE_DOWN_DISTINCT
  if (takenDown) {
    await db.collection(POST_COL).doc(id).update({
      data: {
        // blocked ≠ 删除：先置 private 下架，保留 7 天申诉期
        // prevVisibility 存原值：申诉通过时要还原，否则「原本就是仅自己可见」的内容会被误公开
        prevVisibility: p.visibility || 'all',
        visibility: 'private',
        audit: 'blocked',
        auditAt: db.serverDate(),
        auditNote: '被举报下架(' + distinct + '人)'
      }
    })
  }
  return { errCode: 0, takenDown, reporters: distinct }
}

async function handleAppealPost(openid, petId, id, note) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  const p = await getDoc(POST_COL, id)
  if (!p || (p.petId && p.petId !== petId)) return { errCode: 404, errMsg: '记录不存在' }
  if ((p.createdBy || p._openid) !== openid) return { errCode: 403, errMsg: '只能申诉自己发布的内容' }
  if (p.appeal && p.appeal.status === 'open') return { errCode: 0, duplicated: true }
  await db.collection(POST_COL).doc(id).update({
    data: { appeal: { status: 'open', at: db.serverDate(), note: String(note || '').slice(0, 200) } }
  })
  return { errCode: 0 }
}

// ============ 内容安全（PRD v2.1 6.7：文案 P0 同步拦截） ============
// ⚠️ 具体实现已迁到 ./sec.js（云调用 + 自换 access_token HTTPS 双路兜底），这里只留 action 壳

async function handleCheckText(openid, text) {
  const r = await sec.checkText(openid, text)
  return Object.assign({ errCode: 0 }, r)
}

/**
 * 内容安全自检（ops 后台一键跑，也可以云端测试直接调）
 *
 * 目的：把「两个检测接口到底通不通」变成一句话能看出来的结论。
 * 没有它时，接口挂了和「内容都是干净的」在现象上完全一样（都发得出去），
 * 排查只能靠翻日志猜。
 *
 * 图片那一步拿**调用者自己最新一条图文的 thumb** 去测 —— 不用另外准备素材，
 * 也能顺带看出真实场景下的 Buffer 体积有没有踩到 100KB 那条线。
 */
async function handleSecSelfTest(openid) {
  // ⚠️ 白名单（fail-close）：secSelfTest 会探测风控表、暴露 SEC_FORCE_REJECT 配置状态，
  //    属于「帮攻击者摸清防御部署」的侦查型接口，只有 SEC_TEST_OPENIDS 里的账号能打。
  //    没配 = 谁都调不了（这是刻意的：要用时先把你的 openid 配进去再部署）。
  const allowRaw = String(process.env.SEC_TEST_OPENIDS || '').trim()
  const allowList = allowRaw ? allowRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  if (allowList.indexOf(openid) === -1) {
    return { errCode: 403, errMsg: 'secSelfTest 仅限白名单：把你的 openid 配进 petData 环境变量 SEC_TEST_OPENIDS 后重新部署' }
  }

  const out = { errCode: 0, build: BUILD, ok: true }

  const t0 = Date.now()
  const tr = await sec.checkText(openid, '今天带它去公园玩了一圈，跑得特别欢')
  out.text = {
    pass: tr.pass !== false,
    unchecked: !!tr.unchecked,
    reason: tr.reason || '',
    ms: Date.now() - t0
  }

  try {
    const r = await db.collection(POST_COL)
      .where({ createdBy: openid }).orderBy('createdAt', 'desc').limit(1).get()
    const p = (r.data || [])[0]
    const im = p && p.images && p.images[0]
    const fid = im && (im.thumbID || im.fileID)
    if (!fid) {
      out.image = { skipped: true, note: '还没有图文，先发一条再来测' }
    } else {
      const b0 = Date.now()
      const dl = await cloud.downloadFile({ fileID: fid }).catch(() => null)
      const buf = dl && dl.fileContent
      const info = { bytes: buf ? buf.length : 0, ms: Date.now() - b0 }
      if (!buf || !buf.length) {
        info.verdict = 'error'
        info.note = '下载失败（云存储权限？）'
      } else if (buf.length > sec.IMG_MAX_BYTES) {
        // ⚠️ 这是「图片永远检测不了」的头号原因，必须单独报出来
        info.verdict = 'error'
        info.note = '超过 ' + Math.round(sec.IMG_MAX_BYTES / 1024) + 'KB，imgSecCheck 会报图片太大'
      } else {
        info.verdict = await sec.checkImgBuffer(buf)
        info.md5 = sec.md5(buf)
      }
      out.image = info
    }
  } catch (e) {
    out.image = { verdict: 'error', note: String((e && e.message) || e).slice(0, 120) }
  }

  // 强制拦截开关的状态（配了环境变量但容器还没重启时，这里会如实说「未生效」）
  const force = String(process.env.SEC_FORCE_REJECT || '').trim()
  out.forceReject = !force
    ? '未配置'
    : (force === openid ? '已开启 · 指向当前账号（你发的图文会被拒）' : '已配置但指向别的 openid，当前账号不受影响')

  // 风控三张表在不在（集合没建的话这里会报错，但**不阻断发布**—— 那是刻意设计的 fail-open）
  out.cols = {}
  for (const c of ['banned', 'reports', 'auditWhitelist', 'rateLimit']) {
    try {
      await db.collection(c).limit(1).get()
      out.cols[c] = 'ok'
    } catch (e) {
      out.cols[c] = '缺失'
    }
  }
  return out
}

// ============ 成员关系 ============

async function handleListMembers(openid, petId) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权访问' }

  const r = await db.collection('petMembers')
    .where({ petId, status: 'active' })
    .orderBy('joinedAt', 'asc').get()

  // petMembers 的昵称/头像只是建档/入伙时刻的快照；用户后来在「我的」页改过就过期了。
  // 展示层用 users 表最新 settings 覆盖（users 查询失败不影响主数据）
  const openids = r.data.map(x => x._openid).filter(Boolean)
  if (openids.length) {
    try {
      const us = await db.collection('users').where({ _openid: _.in(openids) }).limit(100).get()
      const uMap = {}
      us.data.forEach(u => { if (u && u.settings) uMap[u._openid] = u.settings })
      r.data.forEach(x => {
        const s = uMap[x._openid]
        if (s) {
          if (s.nickname) x.nickname = s.nickname
          if (s.avatar) x.avatar = s.avatar
        }
      })
    } catch (e) { /* 忽略，回落快照 */ }
  }

  // myOpenid：前端标记「我（xx）」行
  return { errCode: 0, data: r.data, myRole: m.role, myNotify: !!m.notify, myOpenid: openid }
}

/** 把 users 表最新昵称头像刷进我的全部 active 成员记录（快照保鲜，邀请/分享卡读快照的场景也受益） */
async function handleSyncMyProfile(openid) {
  let nickname = ''
  let avatar = ''
  try {
    const u = await db.collection('users').where({ _openid: openid }).limit(1).get()
    if (u.data[0] && u.data[0].settings) {
      nickname = u.data[0].settings.nickname || ''
      avatar = u.data[0].settings.avatar || ''
    }
  } catch (e) { /* 忽略 */ }
  if (!nickname && !avatar) return { errCode: 0, updated: 0 }
  const r = await db.collection('petMembers')
    .where({ _openid: openid, status: 'active' })
    .update({ data: { nickname, avatar } })
  return { errCode: 0, updated: (r.stats && r.stats.updated) || 0 }
}

async function handleCreateInvite(openid, petId) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }

  // 成员上限校验
  const cnt = await db.collection('petMembers').where({ petId, status: 'active' }).count()
  if (cnt.total >= MAX_MEMBERS) return { errCode: 101, errMsg: '成员已满（上限 ' + MAX_MEMBERS + ' 人）' }

  // 去抖：复用同一发起人在窗口内刚生成的待接受邀请（备注等字段一并保留）
  const recent = await db.collection('invites')
    .where({ petId, inviterOpenid: openid, status: 'pending' })
    .orderBy('createdAt', 'desc').limit(1).get()
  const last = recent.data[0]
  if (last) {
    const t = last.createdAt && typeof last.createdAt.getTime === 'function'
      ? last.createdAt.getTime()
      : (last.createdAt ? new Date(last.createdAt).getTime() : 0)
    if (t && Date.now() - t < INVITE_REUSE_MS) {
      return { errCode: 0, inviteId: last.inviteId, reused: true }
    }
  }

  const inviteId = genInviteId()
  await db.collection('invites').add({
    data: {
      inviteId,
      petId,
      inviterOpenid: openid,
      // 邀请人昵称快照：成员页「由 XX 邀请」展示用（事后 inviter 可能退出，落库时固化）
      inviterName: m.nickname || '',
      status: 'pending',
      expireAt: new Date(Date.now() + INVITE_MS),
      createdAt: db.serverDate()
    }
  })
  return { errCode: 0, inviteId }
}

async function handlePreviewInvite(openid, inviteId) {
  const inv = await getInvite(inviteId)
  if (!inv) return { errCode: 201, reason: 'revoked' }
  if (inv.status === 'used') return { errCode: 201, reason: 'used' }
  if (inv.status === 'revoked') return { errCode: 202, reason: 'revoked' }
  if (inv.expireAt && inv.expireAt.getTime && inv.expireAt.getTime() < Date.now()) {
    return { errCode: 203, reason: 'expired' }
  }

  // 宠物名（异常态文案需要插值，如「朵屁已经有 5 个人在记录了」）
  const petRes = await db.collection('pets').doc(inv.petId).get()
  const petName = (petRes.data && petRes.data.name) || '这只宠物'

  // 成员上限校验
  const cnt = await db.collection('petMembers').where({ petId: inv.petId, status: 'active' }).count()
  if (cnt.total >= MAX_MEMBERS) return { errCode: 204, reason: 'full', petName }

  // 是否已是成员
  const mine = await getMember(inv.petId, openid)
  if (mine) {
    // ⚠️ 已加入的人再点开这条链接：邀请已经完成使命，必须消费掉。
    // 否则成员页会长期挂着一条「待接受」——而人明明已经在成员列表里了
    try {
      await db.collection('invites').where({ inviteId, status: 'pending' }).update({
        data: { status: 'used', usedBy: openid, usedAt: db.serverDate() }
      })
    } catch (e) { /* 消费失败不影响预览 */ }
    return { errCode: 205, reason: 'already', petId: inv.petId, petName, memberCount: cnt.total }
  }

  const inviter = await getMember(inv.petId, inv.inviterOpenid)
  // 成员预览（前 3 个头像+昵称，供落地页「正在记录」条）
  const mRes = await db.collection('petMembers')
    .where({ petId: inv.petId, status: 'active' })
    .limit(3).get()

  return {
    errCode: 0,
    pet: petRes.data,
    petName,
    inviter: inviter ? { nickname: inviter.nickname, avatar: inviter.avatar } : null,
    memberCount: cnt.total,
    members: mRes.data.map((m) => ({ nickname: m.nickname || '', avatar: m.avatar || '' }))
  }
}

async function handleAcceptInvite(openid, inviteId) {
  const inv = await getInvite(inviteId)
  if (!inv) return { errCode: 201, reason: 'revoked' }
  if (inv.status === 'used') return { errCode: 201, reason: 'used' }
  if (inv.status === 'revoked') return { errCode: 202, reason: 'revoked' }
  if (inv.expireAt && inv.expireAt.getTime && inv.expireAt.getTime() < Date.now()) {
    return { errCode: 203, reason: 'expired' }
  }

  // ⚠️ 先消费邀请，再补成员。顺序反过来时，只要中间某一步失败（写成员成功、
  // memberCount 同步失败等），就会出现「人已经加入了，但邀请还挂在待接受」的僵尸数据
  await db.collection('invites').where({ inviteId, status: 'pending' }).update({
    data: { status: 'used', usedBy: openid, usedAt: db.serverDate() }
  })

  // 成员上限
  const cnt = await db.collection('petMembers').where({ petId: inv.petId, status: 'active' }).count()
  if (cnt.total >= MAX_MEMBERS) return { errCode: 204, reason: 'full' }

  // 是否已是成员（老链接被重复点开：邀请已在上面消费，这里只返回状态）
  const mine = await getMember(inv.petId, openid)
  if (mine) return { errCode: 205, reason: 'already', petId: inv.petId }

  // 取昵称头像（可选设置）
  let nickname = ''
  let avatar = ''
  try {
    const u = await db.collection('users').where({ _openid: openid }).limit(1).get()
    if (u.data[0] && u.data[0].settings) {
      nickname = u.data[0].settings.nickname || ''
      avatar = u.data[0].settings.avatar || ''
    }
  } catch (e) { /* 忽略 */ }

  await db.collection('petMembers').add({
    data: {
      petId: inv.petId,
      _openid: openid,
      role: 'member',
      status: 'active',
      notify: true,
      nickname,
      avatar,
      joinedAt: db.serverDate(),
      invitedBy: inv.inviterOpenid,
      // 邀请人昵称快照（成员列表「由 XX 邀请」）
      invitedByName: inv.inviterName || '',
      // 反查用：待接受列表据此排除已被消费的邀请（老数据的兜底）
      usedInviteId: inviteId
    }
  })

  // 更新 memberCount
  await syncMemberCount(inv.petId)

  return { errCode: 0, petId: inv.petId }
}

async function handleRevokeInvite(openid, inviteId) {
  const inv = await getInvite(inviteId)
  if (!inv) return { errCode: 200, errMsg: '邀请不存在' }

  const m = await getMember(inv.petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  // PRD：owner 可撤销；成员作为发起人也可撤销自己发的邀请（顺手把撤销放宽到发起人本人）
  const isOwner = m.role === 'owner'
  const isInviter = inv.inviterOpenid === openid
  if (!isOwner && !isInviter) return { errCode: 403, errMsg: '无权撤销此邀请' }

  await db.collection('invites').where({ inviteId, status: 'pending' }).update({
    data: { status: 'revoked' }
  })
  return { errCode: 0 }
}

/**
 * 待接受邀请备注（解决「多个待接受邀请分不清发给谁」）：
 * 只允许备注 pending 状态的邀请；owner 或该邀请的发起人可改
 */
async function handleUpdateInviteLabel(openid, inviteId, label) {
  const inv = await getInvite(inviteId)
  if (!inv) return { errCode: 200, errMsg: '邀请不存在' }
  if (inv.status !== 'pending') return { errCode: 104, errMsg: '仅待接受的邀请可备注' }

  const m = await getMember(inv.petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  if (m.role !== 'owner' && inv.inviterOpenid !== openid) {
    return { errCode: 403, errMsg: '无权修改此邀请' }
  }

  const text = String(label == null ? '' : label).trim().slice(0, 12)
  await db.collection('invites').where({ inviteId }).update({ data: { label: text } })
  return { errCode: 0, label: text }
}

async function handleListPendingInvites(openid, petId) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权访问' }

  // 最新的在前：刚发出的邀请排第一，用户回来备注时好认
  const r = await db.collection('invites')
    .where({ petId, status: 'pending' })
    .orderBy('createdAt', 'desc').get()

  // 自愈：老数据里存在「人已加入、邀请状态没更新」的僵尸邀请。
  // 成员记录上带 usedInviteId，凡是已被某个成员消费过的邀请一律不再展示
  const ms = await db.collection('petMembers').where({ petId, status: 'active' }).limit(100).get()
  const usedIds = {}
  ms.data.forEach((x) => { if (x.usedInviteId) usedIds[x.usedInviteId] = true })

  // 过滤已过期（保险，云函数定时可清）
  const now = Date.now()
  const active = r.data.filter((inv) => {
    if (usedIds[inv.inviteId]) return false
    if (inv.usedBy) return false
    if (inv.expireAt && inv.expireAt.getTime && inv.expireAt.getTime() < now) return false
    return true
  })
  return { errCode: 0, data: active }
}

async function handleRemoveMember(openid, petId, targetOpenid) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  if (m.role !== 'owner') return { errCode: 403, errMsg: '仅创建者可移除成员' }
  if (openid === targetOpenid) return { errCode: 102, errMsg: '不能移除自己' }

  await db.collection('petMembers')
    .where({ petId, _openid: targetOpenid, status: 'active' })
    .update({ data: { status: 'removed', leftAt: db.serverDate() } })

  await syncMemberCount(petId)
  return { errCode: 0 }
}

async function handleQuitMember(openid, petId) {
  const m = await getMember(petId, openid)
  if (!m) return { errCode: 403, errMsg: '无权操作' }
  if (m.role === 'owner') return { errCode: 103, errMsg: '创建者不能退出，只能删除宠物' }

  await db.collection('petMembers')
    .where({ petId, _openid: openid, status: 'active' })
    .update({ data: { status: 'left', leftAt: db.serverDate() } })

  await syncMemberCount(petId)
  return { errCode: 0 }
}

async function handleUpdateNotify(openid, petId, notify) {
  await db.collection('petMembers')
    .where({ petId, _openid: openid, status: 'active' })
    .update({ data: { notify: !!notify } })
  return { errCode: 0 }
}

// ============ 辅助 ============

function genInviteId() {
  const ts = Date.now().toString(36).slice(-5)
  const rand = Math.random().toString(36).slice(2, 5)
  return (ts + rand).toLowerCase()
}

// ============ 入口 ============

/**
 * 写类 action：命中封禁直接 403（读操作不拦 —— 被封用户仍能看到自己的历史）
 *
 * ⚠️ 删类 action **故意不在名单里**：删除是收敛行为不是扩散行为，
 *    被封用户要能删掉自己的内容（也包括删掉那条违规内容），挡住他反而坏事。
 *    appealPost 同理：被封也要有申诉出口。
 */
const WRITE_ACTIONS = [
  'addPet', 'updatePet',
  'addRecord', 'updateRecord',
  'addPost', 'updatePost',
  'createInvite', 'acceptInvite', 'revokeInvite', 'updateInviteLabel',
  'removeMember', 'quitMember', 'updateNotify', 'syncMyProfile'
]

exports.main = async (event, context) => {
  const wx = cloud.getWXContext()
  const OPENID = wx.OPENID
  if (!OPENID) return { errCode: 500, errMsg: '无法获取 openid' }
  const action = event.action
  if (!action) return { errCode: 1, errMsg: '缺少 action' }
  // 排障信标：确认云端跑的是新 bundle（日志里没有这行 = 还是旧代码）
  console.log('[petData] build =', BUILD, 'action =', action)

  // 封禁统一拦截（PRD 第 9 节）：实例级缓存 30s，读操作与删操作不拦
  if (WRITE_ACTIONS.indexOf(action) >= 0) {
    const ban = await sec.isBanned(OPENID)
    if (ban) {
      console.warn('[petData] 封禁拦截', action, '尾号=', String(OPENID).slice(-6))
      // ⚠️ 前端必须把这条翻成人话，别弹「操作失败」
      return { errCode: 403, errMsg: '账号已被限制', banned: true, banReason: ban.reason || '' }
    }
  }

  try {
    switch (action) {
      // pets
      case 'listPets': return await handleListPets(OPENID)
      case 'addPet': return await handleAddPet(OPENID, event.data)
      case 'updatePet': return await handleUpdatePet(OPENID, event.petId, event.data)

      // records
      case 'listBy': return await handleListBy(OPENID, event.col, event.petId)
      case 'addRecord': return await handleAddRecord(OPENID, event.col, event.petId, event.data)
      case 'updateRecord': return await handleUpdateRecord(OPENID, event.col, event.petId, event.id, event.data)
      case 'removeRecord': return await handleRemoveRecord(OPENID, event.col, event.petId, event.id)
      case 'listExpensesMonth': return await handleListExpensesMonth(OPENID, event.petIdOrAll, event.start, event.end)

      // posts（图文 / 相册，PRD v2.1）
      case 'listPosts': return await handleListPosts(OPENID, event.petId)
      case 'addPost': return await handleAddPost(OPENID, event.petId, event.data)
      case 'removePost': return await handleRemovePost(OPENID, event.petId, event.id)
      case 'checkText': return await handleCheckText(OPENID, event.text)
      // 风控：举报 / 申诉（PRD《内容安全与风控》）
      case 'reportPost': return await handleReportPost(OPENID, event.petId, event.id, event.reason)
      case 'appealPost': return await handleAppealPost(OPENID, event.petId, event.id, event.note)
      case 'secSelfTest': return await handleSecSelfTest(OPENID)

      // members
      case 'listMembers': return await handleListMembers(OPENID, event.petId)
      case 'createInvite': return await handleCreateInvite(OPENID, event.petId)
      case 'previewInvite': return await handlePreviewInvite(OPENID, event.inviteId)
      case 'acceptInvite': return await handleAcceptInvite(OPENID, event.inviteId)
      case 'revokeInvite': return await handleRevokeInvite(OPENID, event.inviteId)
      case 'listPendingInvites': return await handleListPendingInvites(OPENID, event.petId)
      case 'updateInviteLabel': return await handleUpdateInviteLabel(OPENID, event.inviteId, event.label)
      case 'removeMember': return await handleRemoveMember(OPENID, event.petId, event.targetOpenid)
      case 'quitMember': return await handleQuitMember(OPENID, event.petId)
      case 'updateNotify': return await handleUpdateNotify(OPENID, event.petId, event.notify)
      case 'syncMyProfile': return await handleSyncMyProfile(OPENID)

      default: return { errCode: 1, errMsg: '未知 action: ' + action }
    }
  } catch (e) {
    console.error('[petData] error', action, e)
    return { errCode: 500, errMsg: String((e && e.message) || e) }
  }
}