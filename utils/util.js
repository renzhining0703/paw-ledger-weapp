/**
 * 通用工具：日期（中国时区口径）、金额（分为单位的整数）、年龄格式化等
 * 从旧工程 util.js 裁剪改造：剔除全部财务专用函数
 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** Date -> 'YYYY-MM-DD' */
function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 'YYYY-MM-DD' -> Date（本地时区零点） */
function parseDate(str) {
  const [y, m, dd] = str.split('-').map(Number)
  return new Date(y, m - 1, dd)
}

/** 日期分组标签：'10月21日 周三' */
function fmtDayLabel(dateStr) {
  const d = parseDate(dateStr)
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${Number(dateStr.split('-')[1])}月${Number(dateStr.split('-')[2])}日 ${weeks[d.getDay()]}`
}

/** 今天 'YYYY-MM-DD'（客户端中国时区；云函数侧用 nowInChina） */
function todayStr() {
  return fmtDate(new Date())
}

/** Date -> 'YYYY-MM' */
function monthStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 本月 'YYYY-MM' */
function thisMonthStr() {
  return monthStr(new Date())
}

/** 'YYYY-MM' 偏移 n 个月（n 可为负） */
function monthOffset(ym, n) {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return monthStr(d)
}

/** b - a 天数（b 晚于 a 为正） */
function daysBetween(aStr, bStr) {
  return Math.round((parseDate(bStr) - parseDate(aStr)) / 86400000)
}

/** dateStr + n 天 -> 'YYYY-MM-DD' */
function offsetDate(dateStr, n) {
  const d = parseDate(dateStr)
  d.setDate(d.getDate() + n)
  return fmtDate(d)
}

/** 金额：分 -> 'xx.xx' 字符串（禁止浮点直算，用整数运算） */
function fen2yuan(fen) {
  const v = Math.round(Number(fen) || 0)
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  return `${sign}${Math.floor(abs / 100)}.${pad(abs % 100)}`
}

/** 金额：分 -> 千分位展示，如 1,286.50 */
function fen2yuanThousand(fen) {
  const v = Math.round(Number(fen) || 0)
  const sign = v < 0 ? '-' : ''
  const abs = Math.abs(v)
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${int}.${pad(abs % 100)}`
}

/** 元字符串（一位小数以内） -> 分整数；非法返回 null */
function yuan2fen(input) {
  const s = String(input || '').trim()
  if (!s || !/^\d+(\.\d{0,2})?$/.test(s)) return null
  const [i, d = ''] = s.split('.')
  return parseInt(i, 10) * 100 + parseInt((d + '00').slice(0, 2) || '0', 10)
}

/**
 * 最大余数法：把总额 total 按权重 weights 拆分为整数数组，保证 sum == total（误差 0）
 * @param {number} total 整数（分）
 * @param {number[]} weights 权重数组
 * @returns {number[]} 拆分后的整数数组
 */
function largestRemainder(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0)
  if (sum <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (total * w) / sum)
  const floors = exact.map(Math.floor)
  let rest = total - floors.reduce((s, f) => s + f, 0)
  // 按小数部分从大到小补 1
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < order.length && rest > 0; k++, rest--) {
    floors[order[k].i] += 1
  }
  return floors
}

/** 百分比（整数，最大余数法保证和为 100） */
function percentSplit(values) {
  const total = values.reduce((s, v) => s + v, 0)
  const raw = largestRemainder(100, values)
  return total > 0 ? raw : values.map(() => 0)
}

/** 去重数组 */
function uniq(arr) {
  return Array.from(new Set(arr))
}

/**
 * 年龄格式化：'2岁3个月' / '8个月' / '20天'
 * @param {string} birthday 'YYYY-MM-DD'
 */
function formatAge(birthday, nowStr) {
  if (!birthday) return ''
  const b = parseDate(birthday)
  const now = nowStr ? parseDate(nowStr) : new Date()
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth())
  if (now.getDate() < b.getDate()) months--
  if (months < 0) return ''
  if (months < 1) {
    const days = daysBetween(birthday, nowStr || todayStr())
    return days > 0 ? `${days}天` : ''
  }
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y >= 1 && m > 0) return `${y}岁${m}个月`
  if (y >= 1) return `${y}岁`
  return `${m}个月`
}

/**
 * 体重展示格式化：至少保留 1 位小数
 * 整数（5 / 5.00）统一显示为一位小数，避免「5kg / 6.5kg」混排看起来像两种口径
 * 已有小数位的按原样保留（6.5 → 6.5），防止二次四舍五入
 * @param {number|string} v
 * @returns {string}
 */
function fmtWeight(v) {
  if (v === '' || v == null) return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return n.toFixed(1)
}

/**
 * 宠物的初始体重（档案基准值）—— 回落判定的唯一数据源
 *
 * ⚠️ 别在各页面自己写 `pet.weight != null ? pet.weight : pet.initWeight`：
 *    档案页清空初始体重时写的是空串 `''`，`'' != null` 为真，会把
 *    `${fmtWeight('')} ${unit}` 渲染成光秃秃的「 kg」。必须走这里把空串/无效值归一成 null。
 * @param {object} pet
 * @returns {number|null}
 */
function initWeightOf(pet) {
  if (!pet) return null
  const raw = pet.weight != null ? pet.weight : pet.initWeight
  if (raw === '' || raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * 打开底部弹层（重置关闭状态）
 * @param {Page|Component} ctx 持有 setData 的实例
 */
function openSheet(ctx, key, extra) {
  ctx.setData({ [key]: true, [`${key}Closing`]: false, ...(extra || {}) })
}

/**
 * 关闭底部弹层（先播放滑出动画再移除）
 * @returns {number} setTimeout id
 */
function closeSheet(ctx, key, duration) {
  ctx.setData({ [`${key}Closing`]: true })
  return setTimeout(() => {
    ctx.setData({ [key]: false, [`${key}Closing`]: false })
  }, duration || 240)
}

/** 轻提示（居中偏上） */
function toast(title, icon) {
  wx.showToast({ title, icon: icon || 'none', position: 'top' === icon ? 'top' : 'none', duration: 1500 })
}

/**
 * 复制文本（带成功反馈 + 失败兜底）
 *
 * ⚠️ `wx.setClipboardData` 属于**隐私接口**：mp 后台《用户隐私保护指引》里没勾「剪切板」时
 *    一律 fail，errMsg 是 `api scope is not declared in the privacy agreement`（errno 112）。
 *    平台级限制，改代码无解 —— 但必须把原因说出来，否则用户只觉得「点了没反应」
 *    （本项目已踩两次：运营后台复制 openid、我的页复制 openid）。
 * ⚠️ 兜底：调用方最好同时给文本加 `user-select`，长按可以选中复制。
 *
 * @param {string} text 要复制的文本
 * @param {string} [tip] 成功提示文案
 */
function copyText(text, tip) {
  const v = String(text || '')
  if (!v) { toast('没有可复制的内容'); return }
  wx.setClipboardData({
    data: v,
    success: () => toast(tip || '已复制'),
    fail: (e) => {
      const msg = String((e && (e.errMsg || e.message)) || '')
      console.error('[copyText] 复制失败', msg)
      const privacy = /privacy|scope|112/i.test(msg)
      wx.showModal({
        title: privacy ? '复制失败：后台未声明「剪切板」' : '复制失败，请长按选中',
        content: v + (privacy ? '\n\n长按上面这串选中复制即可' : ''),
        showCancel: false,
        confirmText: '知道了'
      })
    }
  })
}

/**
 * 危险操作二次确认：按钮文案写具体动作
 * @param {string} content 正文
 * @param {Function} onConfirm 确认回调（注意：本函数无返回值，别写成 await 取结果）
 * @param {{title?: string, confirmText?: string}} opts 可选：标题与确认按钮文案（≤4 字）
 */
function confirmDelete(content, onConfirm, opts) {
  const o = opts || {}
  wx.showModal({
    title: o.title || '确认删除',
    content,
    confirmText: o.confirmText || '删除',
    confirmColor: '#F0483E',
    cancelText: '取消',
    success: (res) => {
      if (res.confirm) onConfirm()
    }
  })
}

/**
 * 云端错误 → 可读提示
 *
 * PRD v2.1 附 B 2b 明确要求：403 不许只弹「操作失败」。
 * 权限收紧后「删不掉别人的记录」会变成高频正常路径（不是 bug），
 * 用户必须看懂「为什么删不掉」，否则只会反复点。
 */
function toastErr(e, fallback) {
  const msg = String((e && (e.errMsg || e.message)) || '')
  if (e && e.errCode === 403) { toast(msg || '只能操作自己记录的内容'); return }
  if (e && e.errCode === 404) { toast(msg || '记录不存在或已删除'); return }
  if (e && e.errCode === 100) { toast(msg || '已达上限'); return }
  if (/超时|timeout|network|网络|request:fail/i.test(msg)) { toast('网络不太好，稍后再试'); return }
  toast(fallback || '操作失败，请重试')
}

/**
 * 原生 API 超时兜底
 *
 * ⚠️ chooseMedia / compressImage / uploadFile / getImageInfo 在真机上存在
 *    「既不 success 也不 fail」的情况；直接 await 会永久挂死，
 *    用户看到的就是「点了没反应」（本项目已踩三次，见 share-pop / avatar-cropper）。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false
    const t = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error((label || '操作') + '超时'))
    }, ms || 15000)
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clearTimeout(t); resolve(v) },
      (e) => { if (done) return; done = true; clearTimeout(t); reject(e) }
    )
  })
}

/** 系统信息缓存（状态栏高度 / 胶囊位置等，沉浸式头部用） */
let _sysInfo = null
function getUI() {
  if (_sysInfo) return _sysInfo
  const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
  let menu = { top: win.statusBarHeight + 6, height: 32, right: win.windowWidth - 87, width: 87 }
  try {
    const rect = wx.getMenuButtonBoundingClientRect()
    if (rect && rect.height) menu = rect
  } catch (e) { /* 部分环境不可用，用默认值 */ }
  _sysInfo = {
    statusBarHeight: win.statusBarHeight,
    windowWidth: win.windowWidth,
    windowHeight: win.windowHeight,
    navBarHeight: (menu.top - win.statusBarHeight) * 2 + menu.height,
    menuTop: menu.top,
    menuHeight: menu.height,
    menuWidth: menu.width,
    menuRight: win.windowWidth - menu.right,
    dpr: win.pixelRatio || 2
  }
  return _sysInfo
}

/** 宠物头像 cloud:// → 临时 https（分享卡片 imageUrl 用），失败返回 ''（回退默认截图） */
async function petShareImage(pet) {
  if (!pet || !pet.avatar) return ''
  try {
    if (pet.avatar.indexOf('cloud://') === 0) {
      const r = await wx.cloud.getTempFileURL({ fileList: [pet.avatar] })
      return (r.fileList && r.fileList[0] && r.fileList[0].tempFileURL) || ''
    }
    return pet.avatar
  } catch (e) { return '' }
}

module.exports = {
  petShareImage,
  pad,
  fmtDate,
  parseDate,
  fmtDayLabel,
  todayStr,
  monthStr,
  thisMonthStr,
  monthOffset,
  daysBetween,
  offsetDate,
  fen2yuan,
  fen2yuanThousand,
  yuan2fen,
  largestRemainder,
  percentSplit,
  uniq,
  fmtWeight,
  initWeightOf,
  formatAge,
  openSheet,
  closeSheet,
  toast,
  copyText,
  confirmDelete,
  toastErr,
  withTimeout,
  getUI
}
