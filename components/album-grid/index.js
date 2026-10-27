/**
 * album-grid：相册网格（原 pages/album/album 的主体，v1.4a 抽成组件）
 *
 * 相册 = 该宠物所有 posts 里图片的汇总视图（**不新建相册集合**，与时间线同一份数据）：
 * 时间线发的图自动进相册，不需要重复上传。
 *
 * ⚠️ 本组件是从页面**平移**过来的，不是重写：网格、按月分组、私密锁、预览、
 *    内存分页、传照片弹层的逻辑与原来完全一致，只有两处随承载页变化：
 *    ① 「当前宠物」行上移到时光页导航栏（页面级切换，两个分段数据一起换）
 *       → 本组件不再持有 pets / pet-switcher，切换由页面调 reload()
 *    ② 分页触底由页面 onReachBottom 转发到 loadMore()（组件监听不到页面触底）
 *
 * 口径（不变）：
 * - 3 列网格、按月分组吸顶、按时间倒序
 * - 列表只用 thumb（长边 480/q60），点开预览才用 full（长边 1080/q75）
 * - 私密照片也在相册里（对作者本人可见），角上有小锁
 * - 「共 N 张」与分页都按「我可见的照片」算，私密内容不会让条数跳变
 */
const store = require('../../utils/store')
const db = require('../../utils/db')
const U = require('../../utils/util')
const TL = require('../../utils/timeline')
const track = require('../../utils/track')
const media = require('../../utils/media')

const PAGE_STEP = 30

Component({
  properties: {
    /**
     * 是否是当前显示的分段。
     * ⚠️ 用 hidden 隐藏而不是 wx:if：组件实例不销毁 → 数据、分页进度、滚动位置都留着，
     *    切回来不用重新加载（PRD 要求「分段切换保留各自数据与滚动位置」）
     */
    active: { type: Boolean, value: false },
    /** 月份标题吸顶的 top（px）。时光页三层吸顶：导航 + 分段 + 月份，由页面算好传进来 */
    stickyTop: { type: Number, value: 0 }
  },

  data: {
    loading: true,
    error: false,
    pet: null,
    groups: [],
    total: 0,
    shown: 0,
    hasMore: false,
    earliestText: '',
    endText: '',
    showPost: false,
    postMax: 9,
    postVia: 'album',
    postPetName: ''
  },

  lifetimes: {
    attached() {
      this._photos = []
      this._count = 0
      // 首屏就是相册分段（少见，但外部可指定）时直接加载；否则等切过来再加载
      if (this.data.active) this.load(true)
    }
  },

  observers: {
    // 懒加载：第一次切到相册分段才拉数据，之后保留实例内数据不再重载
    active(v) {
      if (v && !this._loaded) this.load(true)
    }
  },

  methods: {
    /**
     * @param {boolean} force 是否强制回源（共享宠物下别人的新照片本地感知不到，必须回源）
     * @param {boolean} keepCount 保留已展示条数（切 tab 回来回源时用，避免丢滚动位置）
     */
    async load(force, keepCount) {
      this._loaded = true
      this._ver = store.dirtyVer()
      this.setData({ loading: !this._photos.length, error: false })
      try {
        await getApp().ready(2000)
        const pet = store.getCurrentPet()
        if (!pet) {
          this.setData({ loading: false, pet: null, groups: [], total: 0 })
          return
        }
        const posts = await db.listPosts(pet._id, { force })
        const photos = []
        posts.forEach((p) => {
          ;(p.images || []).forEach((im, i) => {
            const thumb = (im && (im.thumbID || im.fileID)) || ''
            if (!thumb) return
            photos.push({
              tid: `${p._id}_${i}`,
              thumb,
              full: (im && im.fileID) || thumb,
              date: p.date || '',
              priv: p.visibility === 'private',
              at: p.createdAtMs || 0
            })
          })
        })
        // 倒序：先按记录日期，再按创建时间（同一天多条时新的在前）
        photos.sort((a, b) => {
          const d = String(b.date).localeCompare(String(a.date))
          return d !== 0 ? d : (b.at - a.at)
        })
        photos.forEach((x, i) => { x.idx = i })
        this._photos = photos
        if (!keepCount) this._count = 0

        const earliest = photos[photos.length - 1]
        const endText = earliest
          ? (pet.adoptDay && earliest.date === pet.adoptDay
            ? `${pet.name || '它'}的照片都在这儿了 · 到家那天`
            : `${pet.name || '它'}的照片都在这儿了`)
          : ''
        this.setData({
          pet,
          earliestText: earliest ? `最早的一张 · ${String(earliest.date).replace(/-/g, '.')}` : '',
          endText,
          postPetName: pet.name || ''
        })
        this.applyPage(!keepCount)
      } catch (e) {
        console.error('[album-grid] 加载失败', e)
        this.setData({ loading: false, error: true })
      }
    },

    /** 内存分页（数据一次拉回，避免每页一次云函数调用） */
    applyPage(reset) {
      const total = this._photos.length
      const count = reset ? PAGE_STEP : (this._count + PAGE_STEP)
      const shown = this._photos.slice(0, count)
      this._count = shown.length
      this.setData({
        loading: false,
        total,
        shown: shown.length,
        hasMore: shown.length < total,
        groups: TL.groupByMonth(shown)
      })
      this._seenVer = this._ver
    },

    /** 页面 onReachBottom 转发进来（组件监听不到页面触底） */
    loadMore() {
      if (this.data.hasMore) this.applyPage(false)
    },

    /** 切换宠物：清空重来（宠物是页面级的，换一次两个分段数据一起换）
     *  不在当前分段时只清数据标脏，等切过来时 observer 会重新拉 */
    reload() {
      this._photos = []
      this._count = 0
      this._loaded = false
      if (this.data.active) this.load(true)
    },

    /**
     * 全屏预览
     * ⚠️ previewImage 只吃 http(s)，cloud:// fileID 会白屏 → 先换临时链接
     * ⚠️ 只换「已渲染的那一段」：相册可能有上千张，全量换链接会产生几十次请求
     */
    async onPreview(e) {
      const idx = Number(e.currentTarget.dataset.i) || 0
      const shown = this._photos.slice(0, this._count || this._photos.length)
      const ids = shown.map((x) => x.full).filter(Boolean)
      if (!ids.length) return
      const big = ids.length > 60
      if (big) wx.showLoading({ title: '图片加载中', mask: false })
      let all = []
      try {
        all = await media.toTempUrls(ids)
      } finally {
        if (big) wx.hideLoading()
      }
      const pairs = []
      all.forEach((u, k) => { if (u) pairs.push({ u, k }) })
      if (!pairs.length) { U.toast('图片加载失败，稍后再试'); return }
      const hit = pairs.filter((p) => p.k === idx)[0] || pairs[0]
      wx.previewImage({ urls: pairs.map((p) => p.u), current: hit.u })
      track.track('photo_viewed', { petId: (this.data.pet || {})._id || '', imgCount: pairs.length })
    },

    /**
     * 图片加载失败（<image> 的 error 是静默的，不提示就变成一排灰格子）
     * ⚠️ 共享宠物下最常见的根因：云存储权限不是「所有用户可读」，
     *    成员上传的图片 owner/member 都读不到。只提示一次，避免刷屏
     */
    onImgErr() {
      console.error('[album-grid] 图片加载失败（检查云存储权限是否为「所有用户可读」）')
      if (this._imgErrNotified) return
      this._imgErrNotified = true
      U.toast('部分图片加载失败，检查云存储权限')
    },

    onAddPhoto() {
      const pet = store.getCurrentPet()
      if (!pet || !pet._id) { U.toast('先创建宠物档案'); return }
      this.setData({ showPost: true, postMax: 9, postVia: 'album', postPetName: pet.name || '' })
    },
    onPostClose() { this.setData({ showPost: false }) },
    onPostSaved() {
      this.setData({ showPost: false })
      U.toast('已加入光影')
      this.load(true)
    },

    onRetry() { this.load(true) }
  }
})
