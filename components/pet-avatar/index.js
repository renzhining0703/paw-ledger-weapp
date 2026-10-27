/**
 * pet-avatar：宠物/用户头像（统一兜底口径）
 * - 有真头像（拍/传的图）→ 显示图片
 * - 无头像 → 显示物种 emoji（config.SPECIES.emoji 唯一数据源）；未选物种或 paw=true → 🐾
 * - 尺寸/圆角/底色可配：首页名片圆白底、列表方软底、切换弹框、档案页大圆、我的页用户头像
 */
const config = require('../../utils/config')

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  properties: {
    src: { type: String, value: '' },
    /**
     * 小头像 fileID（上传宠物头像时顺带生成的 200px 档）
     * 只在「小尺寸」（≤88rpx）时启用 —— 大尺寸位置继续用原图，避免放大后发虚。
     * 不传 / 生成失败时自动回落 src，调用方不用做兼容判断。
     */
    smallSrc: { type: String, value: '' },
    /** 物种 key（cat/dog/...） */
    species: { type: String, value: '' },
    /** 强制显示 🐾 占位（新建档案尚未选物种） */
    paw: { type: Boolean, value: false },
    /** 尺寸 rpx */
    size: { type: Number, value: 88 },
    /** 圆角 rpx；0 = 圆形 */
    radius: { type: Number, value: 0 },
    /** 底色：soft（浅橙）/ white */
    tone: { type: String, value: 'soft' }
  },
  data: {
    useSrc: '',
    emojiText: '🐾',
    emojiSize: 44,
    radiusStyle: '50%',
    bgStyle: 'var(--orange-soft)',
    borderStyle: 'none',
    /** src 加载失败标记：true 时回落 emoji（onErr 置位，src 变化时在 refresh 里复位重试） */
    broken: false
  },
  observers: {
    'src, smallSrc, species, paw, size, radius, tone'() {
      this.refresh()
    }
  },
  lifetimes: {
    attached() {
      this.refresh()
    }
  },
  methods: {
    /**
     * 图片加载失败 → 先退回主头像，再不行才回落 emoji
     * ⚠️ 小图档是「优化项」：它挂了不该把头像整个弄丢，
     *    所以第一次 error 时换回 src 再给一次机会，第二次才认输
     */
    onErr() {
      const d = this.data
      if (this._usingSmall && d.src && d.src !== d.useSrc) {
        console.warn('[pet-avatar] 小头像加载失败，退回主头像:', String(d.useSrc).slice(0, 60))
        this._usingSmall = false
        this.setData({ broken: false, useSrc: d.src })
        return
      }
      console.warn('[pet-avatar] 头像加载失败，回落 emoji:', String(d.useSrc).slice(0, 60))
      this.setData({ broken: true })
    },

    refresh() {
      const d = this.data
      const sp = config.SPECIES.find((s) => s.key === d.species)
      // 用户头像（既无图也无物种）用虚线占位，对齐设计稿「我的」页 .mine-ava.ph
      const userPh = !d.src && !sp && !d.paw
      // 小尺寸才用小图档：88rpx 是「切换弹框 / 相册顶行 / 记账宠物条」这一档的上限
      const useSmall = d.size <= 88 && !!d.smallSrc
      this._usingSmall = useSmall
      this.setData({
        // src 变化/组件重挂时复位，给新 src 一次加载机会
        broken: false,
        useSrc: useSmall ? d.smallSrc : d.src,
        emojiText: d.paw || !sp ? '🐾' : (sp.emoji || '🐾'),
        emojiSize: Math.max(20, Math.round(d.size * 0.5)),
        radiusStyle: d.radius ? `${d.radius}rpx` : '50%',
        bgStyle: userPh ? 'rgba(255,255,255,.55)' : (d.tone === 'white' ? '#fff' : 'var(--orange-soft)'),
        borderStyle: userPh ? '3rpx dashed #D9A96F' : 'none'
      })
    }
  }
})
