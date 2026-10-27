/**
 * 记账页（tab3）：月份切换 + 总支出/环比/日均 + 6 类占比（最大余数法对账）+ 按日分组流水
 * 统计口径随顶部宠物 chips 变化（全部 / 各宠物，PRD 5.6）
 */
const config = require('../../utils/config')
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')

Page({
  data: {
    loading: true,
    error: false,
    petChips: [],      // 全部 + 各宠物
    scopeIndex: 0,     // 当前统计范围
    ym: '',            // 'YYYY-MM'
    ymLabel: '',
    canPrev: false,
    canNext: false,
    totalText: '0.00',
    momUp: false,
    momDown: false,
    momText: '',
    avgText: '',
    bars: [],          // 分类占比
    groups: [],        // 按日分组流水
    isEmpty: false,
    pets: []
  },

  onShow() {
    if (!this.data.ym) this.setData({ ym: U.thisMonthStr() })
    // 有写入后强制回源（例如在首页记了一笔再切过来）
    this.refresh(store.dirtyVer() !== this._seenVer)
  },

  onLoad() {
    store.on('petChanged', () => this.refresh(true))
  },

  onPullDownRefresh() {
    this.refresh(true).finally(() => wx.stopPullDownRefresh())
  },

  async refresh(force) {
    // 记录本次刷新对应的版本（而非结束时的），刷新期间的写入不能被算作已看到
    const ver = store.dirtyVer()
    this.setData({ loading: !this.data.groups.length && !this.data.isEmpty, error: false })
    try {
      await getApp().ready(2000)
      const pets = await db.listPets(force)
      store.state.pets = pets
      // chips：全部 + 各宠物（带头像字段，无图由 pet-avatar 按物种 emoji 兜底）
      const chips = [{ _id: 'all', name: '全部' }].concat(pets.map((p) => ({
        _id: p._id,
        name: p.name,
        avatar: p.avatar || '',
        species: p.species || ''
      })))
      let idx = this.data.scopeIndex
      if (idx >= chips.length) idx = 0
      const scope = chips[idx]

      const ym = this.data.ym
      const [list, prevList] = await Promise.all([
        db.listExpensesMonth(scope._id, ym, force),
        db.listExpensesMonth(scope._id, U.monthOffset(ym, -1), force)
      ])

      // 月份边界：不早于首笔记录月、不晚于当前月
      let firstMonth = null
      const cur = store.getCurrentPet()
      if (cur) {
        const all = await db.listBy('expenses', cur._id, { force })
        if (all.length) firstMonth = all[all.length - 1].date.slice(0, 7)
      }

      // 汇总（分）
      const cats = config.EXPENSE_CATEGORIES.map((c) => ({ ...c, fen: 0 }))
      let total = 0
      list.forEach((e) => {
        total += e.amount || 0
        const c = cats.find((x) => x.key === e.category)
        if (c) c.fen += e.amount || 0
      })
      const prevTotal = prevList.reduce((s, e) => s + (e.amount || 0), 0)
      const momPct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null

      // 日均（按本月已过天数）
      const today = U.todayStr()
      const [y, m] = ym.split('-').map(Number)
      const daysPassed = ym === U.thisMonthStr() ? Number(today.split('-')[2]) : new Date(y, m, 0).getDate()
      const avgFen = daysPassed > 0 ? Math.round(total / daysPassed) : 0

      // 占比条（最大余数法，PRD 6.6 对账误差为 0）
      const active = cats.filter((c) => c.fen > 0).sort((a, b) => b.fen - a.fen)
      const pcts = U.percentSplit(active.map((c) => c.fen))
      active.forEach((c, i) => { c.pct = pcts[i] })

      // 流水按日分组（含宠物名小标，跨宠物时显示）
      const petMap = {}
      pets.forEach((p) => { petMap[p._id] = p.name })
      const dayMap = {}
      const order = []
      list.forEach((e) => {
        if (!dayMap[e.date]) {
          dayMap[e.date] = { date: e.date, label: U.fmtDayLabel(e.date), total: 0, items: [] }
          order.push(e.date)
        }
        dayMap[e.date].total += e.amount || 0
        dayMap[e.date].items.push({
          ...e,
          amountText: U.fen2yuan(e.amount),
          catName: (config.EXPENSE_CATEGORIES.find((c) => c.key === e.category) || {}).name || '其他',
          catColor: (config.EXPENSE_CATEGORIES.find((c) => c.key === e.category) || {}).color || '#8C8177',
          petName: petMap[e.petId] || ''
        })
      })
      const groups = order.map((d) => ({
        ...dayMap[d],
        totalText: U.fen2yuan(dayMap[d].total)
      }))

      this.setData({
        loading: false,
        pets,
        petChips: chips,
        scopeIndex: idx,
        ym,
        ymLabel: `${y}年${m}月`,
        canPrev: firstMonth ? ym > firstMonth : total > 0 || prevTotal > 0,
        canNext: ym < U.thisMonthStr(),
        totalText: U.fen2yuanThousand(total),
        momUp: momPct != null && momPct > 0,
        momDown: momPct != null && momPct < 0,
        momText: momPct != null ? `${Math.abs(momPct)}%` : '',
        avgText: U.fen2yuan(avgFen),
        bars: active.map((c) => ({ ...c, w: Math.max(c.pct, 3), fenText: U.fen2yuan(c.fen) })),
        groups,
        isEmpty: total === 0 && list.length === 0
      })
      this._seenVer = ver
    } catch (e) {
      console.error('记账页加载失败', e)
      this.setData({ loading: false, error: true })
    }
  },

  onRetry() { this.refresh(true) },
  noop() {},

  onScope(e) {
    const idx = Number(e.currentTarget.dataset.i)
    this.setData({ scopeIndex: idx })
    this.refresh()
  },

  onPrevMonth() {
    if (!this.data.canPrev) return
    this.setData({ ym: U.monthOffset(this.data.ym, -1) })
    this.refresh()
  },
  onNextMonth() {
    if (!this.data.canNext) return
    this.setData({ ym: U.monthOffset(this.data.ym, 1) })
    this.refresh()
  },

  /** 点图例筛选流水 [简单实现：高亮分类并过滤] */
  onLegend(e) {
    const key = e.currentTarget.dataset.k
    const cur = this.data.legendKey === key ? '' : key
    this.setData({ legendKey: cur })
    if (!cur) { this.refresh(); return }
    // 过滤当前 groups
    const groups = this.data.groups
      .map((g) => ({ ...g, items: g.items.filter((it) => it.category === key) }))
      .filter((g) => g.items.length)
    this.setData({ groups })
  },

  onAdd() {
    this.selectComponent('#recordSheet').open({ mode: 'expense' })
  },

  onItemTap(e) {
    const { id, date } = e.currentTarget.dataset
    const ym = date.slice(0, 7)
    // 从缓存里找到原记录
    const g = this.data.groups.find((x) => x.items.some((it) => it._id === id))
    const record = g && g.items.find((it) => it._id === id)
    if (record) {
      this.selectComponent('#recordSheet').open({ mode: 'edit', col: 'expenses', record })
    }
  },

  onSheetSaved() { this.refresh(true) },
  onSheetSaved() { this.refresh(true) },
  goHome() { wx.switchTab({ url: '/pages/home/home' }) }
})
