/**
 * timeline-item v3（PRD v2.1 时间线图文）
 * 版式：彩色小圆点（记录）/ 橙爪印（里程碑）节点 + 白卡片
 * r1 = 类型标签 + 标题（省略号）+ 右侧短时间；r2 = 描述小字
 *
 * v3 新增（图文 moment）：
 * - 两种密度：compact（首页 56×56 最多 3 张）/ 完整（时间线 1/2/3 张）
 * - 私密小锁角标（跟在类型标签后）
 * - 署名「小圆头像 + XX 记」（仅别人发的才显示，单用户宠物不显示）
 * - 超过 3 张时第 3 张叠「+N」（时间线保持轻量，别让一条卡占半屏）
 *
 * 排版纪律（踩坑）：
 * - 图片高度用 `padding-bottom: 百分比` 撑，不用 aspect-ratio：
 *   百分比 padding 相对**容器**宽度解析，所以
 *     1 张（宽 100%）→ pb = 高宽比 × 100
 *     1 张竖图（宽 70%）→ pb = 高宽比 × 70
 *     2 / 3 张 → pb = calc((100% - gap总和) / 张数)，正好等于单个格子的宽度
 *   aspect-ratio 在旧 WebView 上不生效会导致图片高度塌成 0（真机白屏）
 */
const U = require('../../utils/util')

const TAG_MAP = {
  vaccine: { label: '疫苗', cls: 'tag-vac' },
  dewormIn: { label: '体内驱虫', cls: 'tag-dew' },
  dewormOut: { label: '体外驱虫', cls: 'tag-dew' },
  checkup: { label: '体检', cls: 'tag-ck' },
  weight: { label: '体重', cls: 'tag-wt' },
  daily: { label: '日常', cls: 'tag-daily' },
  moment: { label: '图文', cls: 'tag-moment' },
  birthday: { label: '生日', cls: 'tag-bd' },
  home: { label: '到家日', cls: 'tag-home' }
}

/* 节点圆点色（对齐设计稿：日常用浅灰） */
const DOT_COLOR = {
  vaccine: '#4A7DE0',
  dewormIn: '#1E9A80',
  dewormOut: '#1E9A80',
  checkup: '#7B61FF',
  weight: '#2FA36B',
  daily: '#B6ACA2',
  moment: '#FF7A2F'
}

/** 图片格的最大张数：时间线/首页都只露 3 张，多的叠 +N */
const MAX_SHOW = 3
const GAP_RPX = 10        // 图片间距 5pt

/**
 * 计算图片栅格的内联样式（宽度 + 撑高）
 * @param {Array} imgs  [{ w, h }]
 * @returns {Array<{style:string, more:number}>}
 */
function layoutImages(imgs) {
  const n = Math.min(imgs.length, MAX_SHOW)
  const more = imgs.length - n
  const out = []
  /**
   * ⚠️ 宽度必须一并写进内联 style：CSS 里 .ti-th 是 `width:100%` + `flex:0 0 auto`，
   *    只给 padding-bottom 的话多图时每格都是满宽且不收缩 → 横向溢出（已踩）
   */
  const cell = `calc((100% - ${(n - 1) * GAP_RPX}rpx) / ${n})`
  for (let i = 0; i < n; i++) {
    const im = imgs[i] || {}
    let style = ''
    if (n === 1) {
      // 单张按原比例；限制在 16:10 ~ 4:5 之间，避免超长图把一屏占满
      const ratio = (im.w > 0 && im.h > 0) ? im.h / im.w : 0.75
      if (ratio > 1) {
        // 竖图：收窄到 70%，观感不笨重（设计稿 n1.v）
        style = `width:70%;padding-bottom:${(70 * Math.min(ratio, 1.25)).toFixed(2)}%;`
      } else {
        style = `width:100%;padding-bottom:${(100 * Math.max(ratio, 0.625)).toFixed(2)}%;`
      }
    } else {
      // 多图：等分正方形（宽 = 高，正好是单个格子的宽度）
      style = `width:${cell};padding-bottom:${cell};`
    }
    out.push({ style, more: (i === n - 1 ? more : 0) })
  }
  return out
}

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  properties: {
    item: { type: Object, value: {} },
    /** 是否为列表最后一项（不画贯穿线） */
    last: { type: Boolean, value: false },
    /** 记录署名（PRD 5.7：member 记的记录显示昵称；owner 自记 / 单用户宠物不传） */
    authorName: { type: String, value: '' },
    /** 紧凑版（首页时间线预览）：不显示描述行、图片走 56×56 小方图 */
    compact: { type: Boolean, value: false }
  },
  data: {
    tagLabel: '',
    tagClass: '',
    titleText: '',
    descText: '',
    dispDate: '',
    dotColor: '#B6ACA2',
    isMilestone: false,
    isMoment: false,
    isPrivate: false,
    authorDisp: '',
    authorInitial: '',
    thumbList: [],
    /** 内容被下架（audit='blocked'）：卡片上挂灰条 + 申诉入口 */
    auditBlocked: false,
    /** 'open' 申诉中 / 'resolved' 已复核 / '' 没申诉过 */
    appealStatus: ''
  },
  observers: {
    'item, compact'(v, compact) {
      if (!v || !v.type) return
      const milestone = v.kind === 'milestone'
      const moment = v.type === 'moment'
      const meta = TAG_MAP[v.type] || TAG_MAP.daily

      // 标签：里程碑显示标题（如「到家一周年」），日常统一「日常」
      const tagLabel = milestone ? (v.title || meta.label) : (v.type === 'daily' ? '日常' : meta.label)
      const tagClass = v.tagClass || meta.cls

      // 时间：今天 → 「今天 08:12」；其余 → 「10-20」短格式
      let dispDate
      if (v.date === U.todayStr()) {
        dispDate = v.time ? `今天 ${v.time}` : '今天'
      } else {
        dispDate = (v.date || '').slice(5)
      }

      let titleText = ''
      let descText = ''
      if (moment) {
        // 图文：首页紧凑版把文案放进标题行（单行省略）；时间线把文案独立成段
        if (compact) titleText = v.desc || ''
        else descText = v.desc || ''
      } else if (milestone) {
        descText = v.desc || ''
      } else if (v.type === 'vaccine' || v.type === 'dewormIn' || v.type === 'dewormOut' || v.type === 'checkup') {
        titleText = [v.title, v.sub].filter(Boolean).join(' · ') || meta.label
        descText = [v.desc, v.cost > 0 ? `¥${U.fen2yuan(v.cost)}` : '', v.nextDate ? `下次 ${v.nextDate}` : '']
          .filter(Boolean).join(' · ')
      } else if (v.type === 'weight') {
        titleText = v.title
        descText = [v.desc, v.note].filter(Boolean).join(' · ')
      } else if (v.type === 'daily') {
        titleText = v.title || ''
        descText = v.desc || ''
      } else {
        titleText = v.title || ''
        descText = v.desc || ''
      }

      // 图片：时间线 1/2/3 张（超 3 张叠 +N）；首页只露小方图但仍最多 3 张
      const imgs = (v.images || []).filter((im) => im && im.thumb)
      const thumbList = imgs.length ? layoutImages(imgs).map((L, i) => ({
        thumb: imgs[i].thumb,
        style: L.style,
        more: L.more,
        // 加载失败占位：<image> 失败是静默的，纯图无文案的卡片会变成一张空白卡，
        // 看起来像「记录不存在」，实际多半是云存储权限没开（共享宠物下成员传的图别人读不到）
        broken: false
      })) : []

      this.setData({
        tagLabel,
        tagClass,
        titleText,
        descText,
        dispDate,
        dotColor: DOT_COLOR[v.type] || DOT_COLOR.daily,
        isMilestone: milestone,
        isMoment: moment,
        isPrivate: moment && v.visibility === 'private',
        // 署名只对「别人发的」生效（云端已按 createdBy 过滤）；单用户宠物前端不传
        authorDisp: moment && !compact ? (v.authorName || '') : '',
        authorInitial: (v.authorName || '').slice(0, 1),
        thumbList,
        // 灰条只对图文生效，且首页紧凑版不渲染（那一行放不下）
        auditBlocked: moment && !compact && v.audit === 'blocked',
        appealStatus: moment ? (v.appealStatus || '') : ''
      })
    }
  },
  methods: {
    onTap() {
      const it = this.data.item
      if (it.kind === 'milestone') {
        // PRD 5.4.1.1：「补记」角标取消后，来源说明由点击提示承载
        wx.showModal({
          title: '来自档案信息',
          content: it.isBackfill
            ? '这一条来自你在档案里填的信息，点这里可以修改'
            : '这一条由宠物档案自动生成，如需修改请编辑宠物档案',
          confirmText: '去编辑',
          cancelText: '知道了',
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({ url: '/pages/pet/edit/edit?id=' + (it._id.split('_')[1] || '') })
            }
          }
        })
        return
      }
      // 图文：点卡片 = 看大图（首页 compact 不预览，交给父级跳时间线）
      if (this.data.isMoment) {
        if (this.data.compact) { this.triggerEvent('edit', { item: it }); return }
        this.triggerEvent('preview', { item: it, index: 0 })
        return
      }
      this.triggerEvent('edit', { item: it })
    },
    onTapImage(e) {
      const i = Number(e.currentTarget.dataset.i) || 0
      this.triggerEvent('preview', { item: this.data.item, index: i })
    },

    /**
     * 图片加载失败：标成 broken，露出占位块
     * ⚠️ 不能静默：共享宠物下最常见的原因是「云存储权限不是所有用户可读」，
     *    成员上传的图片 owner 读不到，表现为空白卡 —— 有占位才看得出来是权限问题不是没记录
     */
    onImgErr(e) {
      const i = Number(e.currentTarget.dataset.i)
      const list = this.data.thumbList || []
      if (!(i >= 0 && i < list.length) || list[i].broken) return
      console.error('[timeline-item] 图片加载失败', list[i].thumb)
      this.setData({ [`thumbList[${i}].broken`]: true })
    },
    /**
     * 申诉「我认为这是误判」
     * ⚠️ 用 catchtap 阻断卡片本身的 onTap（卡片点击是看大图），否则点申诉会先弹出大图
     */
    onAppeal() {
      this.triggerEvent('appeal', { item: this.data.item })
    },

    onLongPress() {
      const it = this.data.item
      if (it.kind === 'milestone') {
        wx.showToast({ title: '里程碑由档案生成，可在档案中调整', icon: 'none' })
        return
      }
      this.triggerEvent('del', { item: it })
    }
  }
})
