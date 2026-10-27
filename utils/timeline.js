/**
 * 时间线聚合（PRD 6.4）：疫苗 / 驱虫 / 体重 / 日常 四集合归并 + 里程碑混入
 * 个人数据量级小（单宠几百条），一次拉取后内存分页，省云配额且实现可靠。
 */
const U = require('./util')
const milestones = require('./milestones')

const TYPE_META = {
  vaccine: { label: '疫苗', tagClass: 'tag-vac', color: '#4A7DE0', icon: '/assets/icons-png/tab-health-on.png' },
  dewormIn: { label: '体内驱虫', tagClass: 'tag-dew', color: '#1E9A80' },
  dewormOut: { label: '体外驱虫', tagClass: 'tag-dew', color: '#1E9A80' },
  checkup: { label: '体检', tagClass: 'tag-ck', color: '#7B61FF' },
  weight: { label: '体重', tagClass: 'tag-wt', color: '#2FA36B' },
  daily: { label: '日常', tagClass: 'tag-daily', color: '#8C8177' },
  // 图文（PRD v2.1 6.6）：暖橙 —— 语义上区分「系统自动生成的记录」与「人亲手写的记录」
  moment: { label: '图文', tagClass: 'tag-moment', color: '#FF7A2F' }
}

function typeMeta(type) {
  return TYPE_META[type] || TYPE_META.daily
}

/** 把一条体重记录换成展示项（含环比：需传该宠物按时间排序的全部体重） */
function weightItem(w, prevValue, unit) {
  let delta = null
  if (prevValue != null) {
    delta = Math.round((w.value - prevValue) * 100) / 100
  }
  return {
    _id: w._id,
    kind: 'record',
    type: 'weight',
    col: 'weights',
    date: w.date,
    time: fmtTime(w),
    title: `${U.fmtWeight(w.value)}${unit || 'kg'}`,
    desc: delta != null ? `比上次${delta > 0 ? '+' : ''}${delta}` : '',
    delta,
    note: w.note || '',
    _sync: w._sync
  }
}

function fmtTime(r) {
  try {
    const d = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)
    if (!isNaN(d.getTime())) return `${U.pad(d.getHours())}:${U.pad(d.getMinutes())}`
  } catch (e) { /* 忽略 */ }
  return ''
}

/**
 * 毫秒时间戳 → 北京时间 HH:mm
 *
 * ⚠️ 云函数 db.serverDate() 写入的时间，经 callFunction 回到前端**不是 Date 实例**
 *    （被序列化成 ISO 字符串 / {$date} / 数字），所以 posts 的 createdAt 由云函数
 *    额外回一个数值 createdAtMs，展示一律走这里，别在前端 new Date(对象)。
 */
function fmtTimeMs(ms) {
  const n = Number(ms) || 0
  if (!n) return ''
  const d = new Date(n + 8 * 3600 * 1000)
  return `${U.pad(d.getUTCHours())}:${U.pad(d.getUTCMinutes())}`
}

/** posts.images → 时间线/相册通用图片项（列表用 thumb，全屏预览用 full） */
function postImages(p) {
  return (p && p.images ? p.images : [])
    .map((im) => ({
      thumb: (im && (im.thumbID || im.fileID)) || '',
      full: (im && im.fileID) || '',
      w: Number(im && im.w) || 0,
      h: Number(im && im.h) || 0
    }))
    .filter((im) => !!im.thumb)
}

/**
 * 归并出展示时间线（含里程碑，倒序）
 * @param {object} pet 宠物档案
 * @param {object} data { health: [], weights: [], daily: [] }（各集合已按 date 倒序）
 * @returns {Array} 展示项列表
 */
function merge(pet, data) {
  const items = []

  ;(data.health || []).forEach((h) => {
    const isVac = h.type === 'vaccine'
    const isCheckup = h.type === 'checkup'
    items.push({
      _id: h._id,
      kind: 'record',
      type: h.type,
      col: 'health',
      date: h.date,
      time: fmtTime(h),
      title: h.name || (isVac ? '疫苗' : isCheckup ? '体检' : h.type === 'dewormIn' ? '体内驱虫' : '体外驱虫'),
      sub: h.dose || '',
      desc: h.note || '',
      nextDate: h.nextDate || '',
      remind: !!h.remind,
      cost: h.cost || 0,
      _sync: h._sync
    })
  })

  const ws = (data.weights || []).slice().sort((a, b) => {
    // 同日按创建时间正序，保证「比上次」指向同日早先的记录
    if (a.date === b.date) return fmtTime(a).localeCompare(fmtTime(b))
    return a.date.localeCompare(b.date)
  })
  ws.forEach((w, i) => {
    const prev = i > 0 ? ws[i - 1].value : null
    items.push(weightItem(w, prev, pet && pet.weightUnit))
  })

  ;(data.daily || []).forEach((d) => {
    items.push({
      _id: d._id,
      kind: 'record',
      type: 'daily',
      col: 'daily',
      date: d.date,
      time: fmtTime(d),
      title: d.tagName || '日常',
      desc: d.note || '',
      _sync: d._sync
    })
  })

  // 图文（PRD v2.1 6.6）：与其它记录同列混排，type=moment、col=posts
  ;(data.posts || []).forEach((p) => {
    const imgs = postImages(p)
    items.push({
      _id: p._id,
      kind: 'record',
      type: 'moment',
      col: 'posts',
      date: p.date || '',
      time: fmtTimeMs(p.createdAtMs) || fmtTime(p),
      title: '',
      desc: p.content || '',
      images: imgs,
      // 'private' 仅作者本人可见（云端已过滤，这里只用于渲染小锁角标）
      visibility: p.visibility === 'private' ? 'private' : 'all',
      authorName: p.authorName || '',
      authorAvatar: p.authorAvatar || '',
      // 云端算好的删除权：作者本人 + owner。菜单据此置灰，别让用户点了才报错
      canDelete: p.canDelete !== false,
      createdBy: p.createdBy || '',
      // 风控状态（PRD《内容安全与风控》）：blocked 时卡片挂灰条 + 申诉入口。
      // ⚠️ 只有作者本人能看到自己这条被下架（云端对别人已经过滤掉了）
      audit: p.audit || 'ok',
      appealStatus: (p.appeal && p.appeal.status) || ''
    })
  })

  milestones.derive(pet).forEach((m) => {
    const st = milestones.style(m.type)
    items.push({
      _id: m._id,
      kind: 'milestone',
      type: m.type,
      date: m.date,
      title: m.title,
      desc: m.desc || '',
      auto: true,
      // PRD 5.4.1.1：判定保留供点击提示判断来源，卡片上不再渲染成角标
      isBackfill: m.isBackfill,
      tagClass: st.tagClass
    })
  })

  items.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date)
    // 同日：里程碑排前面（档案事实先于记录），其余按时间
    if (a.kind !== b.kind) return a.kind === 'milestone' ? -1 : 1
    return (b.time || '').localeCompare(a.time || '')
  })
  return items
}

/** 类型筛选：全部 / vaccine / dewormIn / dewormOut / weight / daily */
function filterItems(items, filter) {
  if (!filter || filter === 'all') return items
  return items.filter((it) => it.type === filter)
}

/**
 * 内存分页
 * @param {Array} items 全量归并结果
 * @param {number} page 从 0 开始
 * @param {number} size 每页条数（默认 20）
 */
function paginate(items, page, size) {
  const s = size || 20
  return items.slice(page * s, page * s + s)
}

/** 按月分组：[{ month: '2026年10月', count, items: [] }]（保持倒序） */
function groupByMonth(items) {
  const map = {}
  const order = []
  items.forEach((it) => {
    const ym = (it.date || '').slice(0, 7)
    if (!map[ym]) {
      map[ym] = { key: ym, month: `${ym.split('-')[0]}年${Number(ym.split('-')[1])}月`, count: 0, items: [] }
      order.push(ym)
    }
    map[ym].items.push(it)
    map[ym].count++
  })
  order.sort((a, b) => b.localeCompare(a))
  return order.map((k) => map[k])
}

/** 首页倒计时：取该宠物疫苗/驱虫各自最早的未过期 nextDate（体检不进首页倒计时卡） */
function nextDue(healthList, today) {
  const res = { vaccine: null, deworm: null }
  ;(healthList || []).forEach((h) => {
    if (!h.nextDate) return
    // ⚠️ 跳过「已结案」的记录：续记时旧记录的 remind 会被置 false（这一针已经打过了），
    //    但它带着更早的 nextDate 留在库里，不排除就会一直霸占倒计时卡，
    //    表现是「刚记完今天的针，首页还写着今天到期」
    if (h.remind === false) return
    if (h.type !== 'vaccine' && h.type !== 'dewormIn' && h.type !== 'dewormOut') return
    const key = h.type === 'vaccine' ? 'vaccine' : 'deworm'
    if (!res[key] || h.nextDate < res[key].nextDate) {
      // ⚠️ 必须带 _id：首页「到期续记」保存后要把这条旧记录的 remind 置 false，
      //    否则它有 nextDate 但已打过针，到期那天还会照推一条（用户收到就是错的提醒）
      res[key] = { _id: h._id, nextDate: h.nextDate, name: h.name || '', type: h.type }
    }
  })
  return res
}

module.exports = { merge, filterItems, paginate, groupByMonth, nextDue, typeMeta, fmtTimeMs, postImages }
