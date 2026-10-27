/**
 * 设置页（二级页，不进 tabBar）
 *
 * 结构：数据组（同步状态 + 清理缓存）+ 关于组（协议/隐私/反馈/关于我们）
 *
 * 同步状态与诊断面板整段从 pages/mine 迁来（含长按弹诊断的交互）：
 * ⚠️ 迁过来时**没有**搬 recordCount / failed 那套统计——它们原来只在「我的」页的
 *    统计块里用得上。这里只关心 pending（待同步）与 dead（已放弃），
 *    口径更准确：`failed`（提醒推送失败）本来就不是「同步状态」，以前混在一起只因为挤在同一张卡上。
 *
 * 清理缓存的边界（做错会丢用户数据）见 CLEAR_KEYS / SAFE_PREFIXES 注释。
 */
const config = require('../../utils/config')
const db = require('../../utils/db')
const U = require('../../utils/util')
const track = require('../../utils/track')

/**
 * 可以清的固定 key（白名单式：只删这里列举的，不碰其它任何东西）
 * - tj_last_sync_at / tj_sync_dead / tj_last_sync_err：同步诊断信息，下次同步会重算
 * - tj_track_queue：埋点待发队列，丢了只是少几个统计点
 */
const CLEAR_KEYS = ['tj_last_sync_at', 'tj_sync_dead', 'tj_last_sync_err', 'tj_track_queue']

/**
 * 可以清的前缀：各集合的 storage 快照（db.js 的 snapKey 生成，形如 tj_snap_pets_xxx）
 * ⚠️ 快照是「几十个 key」而不是一个，且集合/宠物/月份组合会不断新增 ——
 *    所以只能按前缀遍历删，硬编码 key 名一定漏（漏了就等于「清完还是旧数据」）
 */
const CLEAR_PREFIXES = ['tj_snap_']

/**
 * 绝对不能清（写在这里是为了让后来改代码的人一眼看到红线，代码里也真的不碰它们）
 * - tj_sync_queue：待同步写队列，里面有还没上云端的记录，清了 = 直接丢用户数据
 * - tj_anon_id / tj_sid：匿名统计身份，清了统计连续性断掉
 * - tj_user / tj_current_pet / tj_launched：登录态与当前宠物，清了等于把用户踢出登录
 * - tj_agreement_v1：协议同意记录，清了会重新弹协议
 * - tj_cs_gate_*：客服入口频控时间戳，清了会重置频控（不是大事，但没必要）
 */

Page({
  data: {
    version: config.VERSION,

    // 同步状态
    syncOk: true,
    syncText: '已同步',
    syncErrText: '',
    lastSyncText: '',

    // 清理缓存
    cacheText: '0 KB',

    // 对话框
    showClearConfirm: false,
    showClearBlocked: false,
    blockedCount: 0,
    // 文案放 data 而不是 wxml：ui-dialog 的 content 支持 \n 换行（wxss 里 white-space: pre-line），
    // 拦截提示要拼数字，只能在 js 里组
    clearConfirmText: '将清除本机的临时缓存，\n不影响已记录的数据',
    blockedText: '',

    // 诊断面板
    showDiag: false,
    diagRows: [],
    diagDeadRows: [],
    diagEnv: config.CLOUD_ENV,
    diagPending: 0,
    diagDead: 0,
    diagErr: '',
    diagTip: ''
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const pending = db.pendingCount()
    const dead = db.deadList().length
    const lastSync = db.lastSyncAt()
    const err = pending > 0 || dead > 0 ? db.lastSyncError() : null

    let syncErrText = ''
    if (err) {
      const tag = err.code !== '' ? String(err.code) : '网络异常'
      syncErrText = pending > 0
        ? `同步失败（${err.col || ''} · ${tag}）点此查看`
        : `${dead} 条没能同步（${tag}）点此查看`
    } else if (dead > 0) {
      // 死信区：已放弃重试，即使错误缓存被清过也必须露出来
      syncErrText = `${dead} 条没能同步，点此查看`
    }

    this.setData({
      syncOk: pending === 0 && dead === 0,
      syncText: pending > 0 ? `${pending} 条待同步` : (dead > 0 ? `${dead} 条同步失败` : '已同步'),
      syncErrText,
      lastSyncText: lastSync
        ? `上次同步 ${U.fmtDate(new Date(lastSync)).slice(5)} ${U.pad(new Date(lastSync).getHours())}:${U.pad(new Date(lastSync).getMinutes())}`
        : '',
      cacheText: this.fmtSize(this.cacheKb())
    })
  },

  /* ---------- 清理缓存 ---------- */

  /** 当前缓存占用（KB）：wx.getStorageInfoSync 的 currentSize 就是这个口径 */
  cacheKb() {
    try {
      return wx.getStorageInfoSync().currentSize || 0
    } catch (e) {
      return 0
    }
  },

  fmtSize(kb) {
    if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`
    return `${kb} KB`
  },

  onClearTap() {
    const pending = db.pendingCount()
    if (pending > 0) {
      // 红线：队列非空时绝不清（清的是快照，但用户会以为「清了缓存」= 数据没了）
      this.setData({
        showClearBlocked: true,
        blockedCount: pending,
        blockedText: `还有 ${pending} 条记录没同步到云端，\n同步完成后再来清理更稳妥`
      })
      track.track('cache_cleared', { ok: 0, pending })
      return
    }
    this.setData({ showClearConfirm: true })
  },

  onClearCancel() {
    this.setData({ showClearConfirm: false })
  },

  onBlockedOk() {
    this.setData({ showClearBlocked: false })
  },

  onClearConfirm() {
    const beforeKb = this.cacheKb()
    let removed = 0
    try {
      const keys = (wx.getStorageInfoSync().keys) || []
      keys.forEach((k) => {
        const hit = CLEAR_PREFIXES.some((p) => k.indexOf(p) === 0)
        if (!hit) return
        try {
          wx.removeStorageSync(k)
          removed += 1
        } catch (e) { /* 单个 key 删失败不影响其余 */ }
      })
    } catch (e) {
      console.warn('[settings] 读取 storage keys 失败', e)
    }
    CLEAR_KEYS.forEach((k) => {
      try {
        wx.removeStorageSync(k)
        removed += 1
      } catch (e) { /* 不存在就算了 */ }
    })

    // 内存缓存也要失效，否则页面还会拿旧数据渲染（快照删了、memCache 还在）
    db.invalidateAll()

    const afterKb = this.cacheKb()
    const freedKb = Math.max(0, beforeKb - afterKb)
    this.setData({ showClearConfirm: false, cacheText: this.fmtSize(afterKb) })
    U.toast(freedKb > 0 ? `已清理 ${this.fmtSize(freedKb)}` : '已清理')
    console.log('[settings] 清理缓存 keys=', removed, 'freedKb=', freedKb)
    track.track('cache_cleared', { ok: 1, freedKb, removed, pending: 0 })
  },

  /* ---------- 同步状态：点击重试 / 长按诊断 ---------- */

  async onSyncRetry() {
    const r = await db.flushSync()
    if (r && r.skipped) {
      U.toast('正在同步中，稍候再看')
      this.refresh()
      return
    }
    if (r && r.done > 0) {
      U.toast(`已同步 ${r.done} 条`)
      this.refresh()
      return
    }
    if (r && r.remain === 0 && db.deadList().length === 0) {
      U.toast('数据都是最新的')
      this.refresh()
      return
    }
    if (r && r.remain === 0 && db.deadList().length > 0) {
      U.toast(`${db.deadList().length} 条没能同步，看看是为什么`)
      this.openDiag()
      this.refresh()
      return
    }
    const e = db.lastSyncError()
    U.toast(e && e.code !== '' ? `同步失败 ${e.code}` : '同步失败')
    this.openDiag()
    this.refresh()
  },

  async openDiag() {
    this.setData({ showDiag: true, diagRows: [], diagDeadRows: [], diagTip: '检查中…' })
    const rows = await db.diagnose().catch(() => [])
    const deadList = db.deadList()
    const err = db.lastSyncError()
    this.setData({
      diagRows: rows.map((r) => ({
        col: r.col,
        ok: r.ok,
        text: r.ok ? '正常' : (r.errCode !== '' ? String(r.errCode) : '不可用'),
        msg: r.errMsg || ''
      })),
      diagDeadRows: deadList.slice().reverse().map((o, idx) => ({
        idx,
        title: `${this.colName(o.col)} · ${o.action === 'add' ? '新增' : o.action === 'update' ? '修改' : '删除'}`,
        sub: this.deadSummary(o),
        err: o.errCode != null && o.errCode !== '' ? String(o.errCode) : '失败'
      })),
      diagPending: db.pendingCount(),
      diagDead: deadList.length,
      diagErr: err ? `${err.col ? err.col + ' · ' : ''}${err.code !== '' ? err.code + ' · ' : ''}${err.msg}` : '（无）',
      diagTip: this.diagTipOf(rows, err)
    })
  },

  colName(col) {
    return { health: '健康', weights: '体重', daily: '日常', expenses: '花销' }[col] || col
  },

  deadSummary(o) {
    const d = o.data || {}
    let what = d.note || d.name || d.tagName || d.tag || ''
    if (!what && d.amount != null) what = `¥${U.fen2yuan(d.amount)}`
    if (!what) what = d.date || ''
    const t = o.deadAt ? U.fmtDate(new Date(o.deadAt)).slice(5) : ''
    return [what, t].filter(Boolean).join(' · ')
  },

  diagTipOf(rows, err) {
    const bad = rows.filter((r) => !r.ok)
    const names = bad.map((r) => r.col).join('、')
    const all = String((err && err.msg) || '')
    if (bad.some((r) => r.errCode === -502005) || /collection not exists/i.test(all)) {
      return `云开发控制台 → 数据库 → 新建集合：${names || '见上方'}（集合不会自动创建，客户端写入不存在的集合一律失败）`
    }
    if (bad.some((r) => r.errCode === -502003) || /permission denied/i.test(all)) {
      return `把 ${names || '这些集合'} 的权限改为「仅创建者可读写」，否则小程序端无权写入`
    }
    if (/duplicate key|E11000/i.test(all)) {
      return '有集合被误建了 eventId 唯一索引（它只该建在 events 集合上）：花销记录没有 eventId 字段，唯一索引把「没有值」都当成同一个键，第二笔起必然冲突。云控制台 → 数据库 → 出错集合 → 索引管理 → 删除 idx_eventId；再到 events 集合确认这个索引建在那边'
    }
    if (!bad.length) {
      return '集合都能读到，通常是网络波动或环境 ID 不对：确认 config.js 的 CLOUD_ENV 与云控制台一致'
    }
    return '集合读写异常，请核对环境 ID 与集合权限；处理完回到本页再点一次同步状态'
  },

  onSyncDiag() {
    this.openDiag()
  },

  closeDiag() {
    this.setData({ showDiag: false })
  },

  async onRetryDead() {
    const n = db.retryDead()
    if (!n) { U.toast('没有已放弃的记录'); return }
    U.toast(`已放回 ${n} 条，正在重试`)
    const r = await db.flushSync()
    U.toast(r && r.done > 0 ? `已同步 ${r.done} 条` : '仍然失败，先按上面的提示处理')
    this.openDiag()
    this.refresh()
  },

  /* ---------- 关于组 ---------- */

  goAgreement(e) {
    const type = e.currentTarget.dataset.type || 'user'
    wx.navigateTo({ url: `/pages/agreement/agreement?type=${type}` })
  },
  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  },
  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  }
})
