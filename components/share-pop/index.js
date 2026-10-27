/**
 * share-pop：分享长图弹层（canvas 2d，PRD 模块 6 / 交付说明 6.7）
 * - 两种版式：vaccine（疫苗记录）/ timeline（成长时间线）
 * - 版式按设计师定稿《长图-成长时间线.html》绘制：hero 渐变 + 品牌行 + 宠物行
 *   + 白色统计卡（压 hero）+ 节点/卡片时间线 + logo 页脚
 * - ⚠️ 设计稿里贯穿竖线 left:118px 会压到日期列（日期列右缘 128px），
 *   实现时竖线改画在节点圆心 x=182，与日期间隔 52px（用户明确要求避免）
 * - 头像：cloud:// fileID 必须先 getTempFileURL 换链接（真机头像不显示的根因）
 * - 低版本微信分享不可用 → 降级保存相册
 */
const U = require('../../utils/util')
const track = require('../../utils/track')
const CS = require('../../utils/cs')
const store = require('../../utils/store')

// 设计基准 750 宽（与设计稿 1px = 1 单位）
const W = 750

/* ---------- 时间线卡片内嵌图（图文一体，替代独立照片墙） ----------
 * 为什么必须有图：宠物内容的传播力 90% 来自萌照，纯文字长图在小红书/朋友圈几乎没有转发。
 *
 * ⚠️ 版式结论（踩过）：不要把图抽出来做成顶部「照片墙」——
 *    带图那条日常的图跑到顶上、文案还在时间线卡片里，同一条记录被拆到两处，
 *    用户一眼看到的就是「图片和文案分离」。图必须画在**它所属的那张卡片里**。
 *
 * 每条图文记录最多画 3 张，统一小格（等宽等高，空位不画），行高按「这条有没有图」累加。
 */
const IMG_MAX_PER_ROW = 3
const IMG_CELL_H = 160
const IMG_GAP = 10
const IMG_PAD = 26          // 图区与卡片内边的左右距（与文字缩进 ix 一致）
/** 带图卡片在纵向的额外高度：12(图与文字间距) + 160(图格) */
const IMG_EXTRA_H = 12 + IMG_CELL_H
/** 画布坐标：卡片几何量 drawRow 里多处要用，提为模块级（别在函数里重复定义） */
const CARD_X = 236
const CARD_W = W - 44 - CARD_X

// 日期统一点分（2026.10.18）
const dotDate = (s) => (s || '').replace(/-/g, '.')

/**
 * 语义色标签：与 app.wxss 的 --s-* 令牌一一对应（浅底 + 彩色字）
 * 改动此处必须同步 app.wxss，否则分享图与页面时间线会色差
 */
const TAG_STYLE = {
  vaccine: { label: '疫苗', bg: '#EAF1FE', fg: '#4A7DE0' },
  dewormIn: { label: '体内驱虫', bg: '#E7F7F2', fg: '#1E9A80' },
  dewormOut: { label: '体外驱虫', bg: '#E7F7F2', fg: '#1E9A80' },
  checkup: { label: '体检', bg: '#F1EEFF', fg: '#7B61FF' },
  weight: { label: '体重', bg: '#E9F7F0', fg: '#2FA36B' },
  daily: { label: '日常', bg: '#F2EFEA', fg: '#8C8177' },
  birthday: { label: '生日', bg: '#FFF3DC', fg: '#D99000' },
  home: { label: '到家日', bg: '#FFEEE0', fg: '#E06A1B' }
}

/**
 * 「✨ 自动记录」角标配色：与 app.wxss 的 --auto-* 令牌一一对应。
 * 别再顺手用 --s-daily-bg(#F2EFEA)，它在米色卡上对比度不够、看不出是标签。
 */
const AUTO_CHIP = { bg: '#E6DFD3', fg: '#5C534A', line: '#CFC2B0' }

// 时间线节点图标：设计稿同款 emoji（⚖️🛡️🏠🎂💉✨…）用系统字体离线渲染成的 PNG
// （生成脚本 scripts/gen-node-icons.py，改 emoji 要重跑）。
// ⚠️ 为什么画图不直接 fillText emoji：⚖️🛡️ 这类带变体选择符(U+FE0F)的字符
//    在 iOS canvas 上度量不稳 —— 体重直接空白、驱虫偏离圆心（真机已踩）。
const NODE_ICON_SRC = {
  vaccine: '/assets/icons-png/node-vaccine.png',
  dewormIn: '/assets/icons-png/node-dewormIn.png',
  dewormOut: '/assets/icons-png/node-dewormOut.png',
  checkup: '/assets/icons-png/node-checkup.png',
  weight: '/assets/icons-png/node-weight.png',
  daily: '/assets/icons-png/node-daily.png',
  home: '/assets/icons-png/node-home.png',
  birthday: '/assets/icons-png/node-birthday.png'
}
const GENDER_ICON_SRC = {
  f: '/assets/icons-png/ic-gender-f-share.png',
  m: '/assets/icons-png/ic-gender-m-share.png'
}
// 兜底：PNG 加载失败时回落 emoji 文字绘制（iOS 上 ⚖️🛡️ 可能渲染异常，仅兜底用）
const NODE_EMOJI = {
  vaccine: '💉', dewormIn: '💊', dewormOut: '🛡️', checkup: '🩺', weight: '⚖️',
  daily: '✨', home: '🏠', birthday: '🎂'
}

// 官方 Logo（方案A 卡片掌垫）：canvas 无法加载 svg，用包内 PNG
const LOGO_SRC = '/assets/logo/它的时光-Logo-方案A-256.png'

/**
 * 版式配置（source 唯一数据源）
 * - timeline：成长时间线（健康+体重+日常+里程碑，日期列 + 节点线）
 * - vaccine ：仅疫苗记录（橙色徽标「已接种 N 次」）
 * - health  ：全部健康记录（疫苗 + 驱虫 + 体检合并，卡片图标按类型配色）
 * 版式差异集中在这里，新增版式只改这一处
 */
const SRC_META = {
  timeline: { sub: '· 成长时间线', layout: 'timeline' },
  vaccine: {
    sub: '· 疫苗记录',
    layout: 'cards',
    badge: (n) => `已接种 ${n} 次`,
    tip: { ic: '💉', text: '疫苗按时接种，是给它最实在的保护' }
  },
  health: {
    sub: '· 健康记录',
    layout: 'cards',
    badge: (n) => `共 ${n} 条健康记录`,
    tip: { ic: '🩺', text: '疫苗、驱虫、体检，一样都别落下' }
  }
}

function srcMeta(source) {
  return SRC_META[source] || SRC_META.timeline
}

Component({
  data: {
    show: false,
    step: 'loading', // loading | done | error
    filePath: '',
    errMsg: '',
    // 触点 3：长图生成成功后出现（同日 ≤1 次，频次由 csShare 控制）
    csShare: false,
    csFromShare: ''
  },
  methods: {
    /**
     * 生成入口
     * @param {object} opts { source: 'vaccine'|'timeline', pet, records, weights }
     */
    async generate(opts) {
      this._opts = opts
      this.setData({ show: true, step: 'loading' })
      try {
        await this.draw(opts)
        // 触点 3 频次：同日 ≤1 次。peek 只读判断，真正占位放在「确定要展示」这一次，
        // 否则组件反复 setData 会把名额白白吃掉（与首页触点 2 同一个坑）
        const csShare = CS.peek(CS.SOURCES.SHARE)
        if (csShare) CS.canShow(CS.SOURCES.SHARE)
        const pet = opts && opts.pet
        this.setData({ step: 'done', csShare, csFromShare: CS.sessionFrom(CS.SOURCES.SHARE, pet && pet.name, pet && pet.species) })
        track.track('share_image_generated', {
          source: opts.source,
          hasNickname: !!(store.getUser() && store.getUser().nickname)
        })
      } catch (e) {
        console.error('长图生成失败', e)
        // 失败原因透出到错误页：真机上没有 vConsole 也能看到 errMsg，拍照即可回传定位
        this.setData({ step: 'error', errMsg: String((e && (e.errMsg || e.message)) || '未知') })
      }
    },
    close() {
      this.setData({ show: false })
    },

    /**
     * 触点 3 埋点：会话已打开
     * ⚠️ 只埋点不做副作用：会话由微信托管，这里拿不到用户说了什么
     */
    onContact(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
      const ok = String((e && e.detail && e.detail.errMsg) || '').indexOf('contact:ok') !== -1
      track.track('contact_opened', { source: ds.src || CS.SOURCES.SHARE, ok: ok ? 1 : 0 })
    },
    onRetry() {
      if (this._opts) this.generate(this._opts)
    },
    /** 失败原因复制：真机上没 vConsole，拍屏 + 复制回传就能定位 */
    onCopyErrMsg() {
      U.copyText(this.data.errMsg, '已复制失败原因')
    },
    noop() {},

    async draw(opts) {
      return new Promise((resolve, reject) => {
        const query = this.createSelectorQuery()
        query.select('#shareCanvas').fields({ node: true, size: true }).exec(async (res) => {
          if (!res || !res[0] || !res[0].node) return reject(new Error('canvas 节点不存在'))
          const canvas = res[0].node
          const dpr = U.getUI().dpr || 2
          const meta = srcMeta(opts.source)
          // 要画的图直接从记录里收集：图属于哪条记录，就画进哪条卡片（不做独立照片墙）
          const photoIds = this.collectRecordImages(opts && opts.records)

          // ⚠️ 顺序不能反：必须「先加载、后定高」。
          // 行高取决于**实际加载成功几张**；按「请求了几张」定高的话，
          // 弱网下某张图加载失败就会在长图底部多留一段空白（且难以复现）。
          let avatar = null
          let logo = null
          let photoMap = {}
          try {
            // 头像 / Logo / 记录图片 / 节点图标并行加载（任一失败都有回落，不阻断出图）
            const loaded = await Promise.all([
              this.loadAvatar(canvas, opts.pet),
              this.loadLogo(canvas),
              this.loadPhotos(canvas, photoIds),
              this.loadNodeIcons(canvas)
            ])
            avatar = loaded[0]
            logo = loaded[1]
            // fileID → 已加载的 Image：加载失败的位没有映射，画图时自然跳过
            ;(loaded[2] || []).forEach((im, i) => {
              if (im && im.width && photoIds[i]) photoMap[photoIds[i]] = im
            })
          } catch (e) { return reject(e) }

          const H = meta.layout === 'cards'
            ? this.cardsHeight(opts.records)
            : this.timelineHeight(opts.records, photoMap)
          // ⚠️ 真机（iOS）canvas 有物理尺寸上限：单边超限 / 面积超限（约 16.7M 像素）
          //    都会让绘制或导出直接失败，而编辑器没这个限制 —— 「编辑器正常真机失败」的元凶。
          //    dpr=3 的手机上长图 H×3 轻松破万，这里统一钳制：单边 ≤8192、面积 ≤16.7M，
          //    正常长度不受影响（scale 仍是 2/3），只有超长图降采样换「能出图」。
          const scale = Math.max(1, Math.min(dpr, 8192 / W, 8192 / H, Math.sqrt(16777216 / (W * H))))
          canvas.width = Math.round(W * scale)
          canvas.height = Math.round(H * scale)
          const ctx = canvas.getContext('2d')
          ctx.scale(scale, scale)
          if (meta.layout === 'cards') this.drawCards(ctx, opts, H, avatar, logo)
          else this.drawTimeline(ctx, opts, H, avatar, logo, photoMap)
          // 导出固定 2x 分辨率（与画布缩放无关，destWidth/destHeight 决定成图尺寸）
          wx.canvasToTempFilePath({
            canvas,
            destWidth: W * 2,
            destHeight: H * 2,
            success: (r) => {
              this.setData({ filePath: r.tempFilePath })
              resolve(r.tempFilePath)
            },
            // ⚠️ 把真机的失败原因带出去：错误页会显示 errMsg，方便定位（不再只有「请重试」）
            fail: (e) => reject(new Error('导出失败: ' + ((e && e.errMsg) || '未知')))
          }, this)
        })
      })
    },

    /**
     * 加载宠物头像为可绘制 Image
     * 兜底链：档案头像（cloud:// → 临时 https）→ 本地物种图 → null（emoji）
     * ⚠️ canvas.createImage 无法加载 cloud:// fileID，必须先 getTempFileURL
     */
    async loadAvatar(canvas, pet) {
      let src = (pet && pet.avatar) || ''
      if (!src) src = `/assets/icons-png/species-${(pet && pet.species) || 'cat'}.png`
      if (/^cloud:\/\//.test(src)) {
        try {
          // ⚠️ 必须带超时（项目铁律）：真机弱网/云冷启动时这个调用会长时间挂起，
          //    没有超时 = 生成长图永远转圈（编辑器里快所以看不出来）
          const res = await Promise.race([
            wx.cloud.getTempFileURL({ fileList: [src] }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('getTempFileURL 超时')), 8000))
          ]).catch(() => null)
          const f = res && res.fileList && res.fileList[0]
          src = (f && f.tempFileURL) || ''
        } catch (e) { src = '' }
      }
      return this.loadImage(canvas, src)
    },

    /** 加载官方 Logo PNG（失败返回 null，页脚回落手绘渐变块+爪印） */
    loadLogo(canvas) {
      return this.loadImage(canvas, LOGO_SRC)
    },

    /**
     * 预载时间线节点图标 + 性别徽标 PNG（本地资源，只载一次，实例级缓存复用）
     * 加载失败的类型回落 emoji 文字绘制，不阻断出图
     */
    async loadNodeIcons(canvas) {
      if (this._iconImgs) return this._iconImgs
      const srcs = Object.assign({}, NODE_ICON_SRC, {
        gender_f: GENDER_ICON_SRC.f,
        gender_m: GENDER_ICON_SRC.m
      })
      const keys = Object.keys(srcs)
      const imgs = await Promise.all(keys.map((k) => this.loadImage(canvas, srcs[k])))
      const map = {}
      keys.forEach((k, i) => { if (imgs[i]) map[k] = imgs[i] })
      this._iconImgs = map
      return map
    },

    /**
     * 单个 src → 可绘制 Image
     * ⚠️ 必须带超时：真机上存在既不触发 onload 也不触发 onerror 的情况（弱网 / 超大图），
     *    没有兜底会让「生成长图」永远停在 loading（项目铁律：所有异步都要超时）
     */
    loadImage(canvas, src) {
      if (!src || typeof canvas.createImage !== 'function') return Promise.resolve(null)
      return new Promise((resolve) => {
        let settled = false
        const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
        const timer = setTimeout(() => done(null), 10000)
        try {
          const img = canvas.createImage()
          img.onload = () => done(img)
          img.onerror = () => done(null)
          img.src = src
        } catch (e) { done(null) }
      })
    },

    /**
     * 批量加载记录图片
     * ⚠️ canvas.createImage 不吃 cloud:// fileID，必须先换临时 https（与头像同一个坑）
     * ⚠️ 返回数组必须与入参**等长对齐**：失败的位为 null。
     *    不能用 filter 剔除失败位 —— 那会让后面的图错位到别的记录头上（张冠李戴）。
     * @returns {Promise<Array>} 与入参等长；失败的位为 null
     */
    async loadPhotos(canvas, fileIDs) {
      const ids = (fileIDs || []).filter(Boolean)
      if (!ids.length || typeof canvas.createImage !== 'function') return []
      let urls = ids
      if (ids.some((x) => /^cloud:\/\//.test(x))) {
        try {
          const res = await wx.cloud.getTempFileURL({ fileList: ids })
          urls = ((res && res.fileList) || []).map((f, i) => (f && f.tempFileURL) || ids[i] || '')
        } catch (e) { return ids.map(() => null) }
      }
      return Promise.all(urls.map((u) => (u ? this.loadImage(canvas, u) : Promise.resolve(null))))
    },

    /**
     * 收集时间线里要画进卡片的图片 fileID（每条最多 IMG_MAX_PER_ROW 张）
     * ⚠️ 红线：visibility === 'private' 的条目绝不取图 —— 分享出去就撤不回来了
     */
    collectRecordImages(records) {
      const out = []
      ;(records || []).slice(0, 12).forEach((r) => {
        if (!r || r.visibility === 'private') return
        ;(r.images || []).slice(0, IMG_MAX_PER_ROW).forEach((im) => {
          const id = (im && (im.thumb || im.thumbID || im.full || im.fileID)) || ''
          if (id) out.push(id)
        })
      })
      return out
    },

    /* ---------- 高度估算 ---------- */
    // 时间线顶 464 + 尾距 40 + 页脚 240 = 744，再加每行实际高度
    // （每行 = 卡片118 + 间距24，带图再加 IMG_EXTRA_H —— 图与文案同卡，高度随记录走）
    timelineHeight(list, photoMap) {
      let h = 464 + 40 + 240
      ;(list || []).slice(0, 12).forEach((r) => { h += this.rowH(r, photoMap) })
      return h
    },
    /** 一行占用的纵向高度：无图 142（卡片118 + 间距24），带图再加图区 */
    rowH(r, photoMap) {
      return 142 + (this.rowImgs(r, photoMap).length ? IMG_EXTRA_H : 0)
    },
    // 卡片版式（vaccine / health）：stats 底 418 + 20 + badge 64 + 32 = 534；保护语 88 + 120 + 页脚 240
    cardsHeight(list) {
      const n = Math.min(list.length, 8)
      return 894 + n * 178
    },

    /* ---------- 绘制基元 ---------- */
    roundRect(ctx, x, y, w, h, r) {
      // ⚠️ 半径必须 clamp 到边长一半：iOS 真机 arcTo 不自动收缩（踩坑沉淀）
      const rr = Math.max(0, Math.min(r, w / 2, h / 2))
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + w, y, x + w, y + h, rr)
      ctx.arcTo(x + w, y + h, x, y + h, rr)
      ctx.arcTo(x, y + h, x, y, rr)
      ctx.arcTo(x, y, x + w, y, rr)
      ctx.closePath()
    },
    text(ctx, str, x, y, size, color, weight, align) {
      ctx.font = `${weight || 400} ${size}px -apple-system, 'PingFang SC', sans-serif`
      ctx.fillStyle = color
      ctx.textAlign = align || 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(str, x, y)
    },
    /** 直线段（w 可选：临时改线宽，不影响后续调用） */
    line(ctx, x1, y1, x2, y2, w) {
      if (w) ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    },
    /** 自动缩字号：超宽时缩小而不是截断 */
    fitText(ctx, str, x, y, size, color, weight, align, maxW) {
      let s = size
      ctx.font = `${weight || 400} ${s}px -apple-system, 'PingFang SC', sans-serif`
      while (s > 22 && ctx.measureText(str).width > maxW) {
        s -= 2
        ctx.font = `${weight || 400} ${s}px -apple-system, 'PingFang SC', sans-serif`
      }
      this.text(ctx, str, x, y, s, color, weight, align)
    },
    truncate(ctx, str, maxW, size, weight) {
      ctx.font = `${weight || 400} ${size}px sans-serif`
      if (ctx.measureText(str).width <= maxW) return str
      let s = str
      while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
      return s + '…'
    },
    /** 设/清投影 */
    shadow(ctx, color, blur, offsetY) {
      if (color) {
        ctx.shadowColor = color
        ctx.shadowBlur = blur
        ctx.shadowOffsetY = offsetY || 0
      } else {
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetY = 0
      }
    },
    /** 画圆头像：白圈 + cover 裁切真头像，无图回落 emoji */
    drawAvatar(ctx, pet, avatar, cx, cy, r) {
      this.shadow(ctx, 'rgba(220,140,70,.26)', 34, 14)
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
      this.shadow(ctx)
      if (avatar && avatar.width) {
        ctx.save()
        ctx.beginPath(); ctx.arc(cx, cy, r - 5, 0, Math.PI * 2); ctx.clip()
        const iw = avatar.width || 1
        const ih = avatar.height || 1
        const s = Math.max((r - 5) * 2 / iw, (r - 5) * 2 / ih)
        ctx.drawImage(avatar, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s)
        ctx.restore()
      } else {
        const spEmoji = { cat: '🐱', dog: '🐶', rabbit: '🐰', bird: '🐦', hamster: '🐹', gecko: '🦎', snake: '🐍', turtle: '🐢', other: '🐾' }
        ctx.font = `${Math.round(r * 1.1)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(spEmoji[pet.species] || '🐾', cx, cy + 4)
      }
    },

    /* ---------- 头部：hero 渐变 + 品牌行 + 宠物行（对齐设计稿 .hero） ---------- */
    drawHero(ctx, pet, avatar, logo, source) {
      const H = 352
      // 155deg 渐变（设计稿 .hero：#FFC896 0% → #FFDFC0 52% → #FDF8F2 100%）
      const grad = ctx.createLinearGradient(241, -112, 509, 464)
      grad.addColorStop(0, '#FFC896')
      grad.addColorStop(0.52, '#FFDFC0')
      grad.addColorStop(1, '#FDF8F2')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)
      // 装饰白圆 blob1 / blob2
      ctx.fillStyle = 'rgba(255,255,255,.42)'
      ctx.beginPath(); ctx.arc(710, 50, 130, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,.34)'
      ctx.beginPath(); ctx.arc(25, 245, 95, 0, Math.PI * 2); ctx.fill()

      // 品牌行：官方 Logo 44x44 + 「它的时光」+「· 成长时间线」
      if (logo && logo.width) {
        ctx.drawImage(logo, 44, 42, 44, 44)
      } else {
        // Logo 加载失败 → 手绘同款渐变圆角块
        this.shadow(ctx, 'rgba(255,110,34,.3)', 14, 6)
        const g = ctx.createLinearGradient(44, 42, 88, 86)
        g.addColorStop(0, '#FFA94D')
        g.addColorStop(1, '#FF6E22')
        ctx.fillStyle = g
        this.roundRect(ctx, 44, 42, 44, 44, 14)
        ctx.fill()
        this.shadow(ctx)
        ctx.font = '24px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('🐾', 66, 65)
      }
      this.text(ctx, '它的时光', 100, 64, 24, '#2C2723', 800)
      ctx.font = `800 24px -apple-system, 'PingFang SC', sans-serif`
      const bw = ctx.measureText('它的时光').width
      this.text(ctx, srcMeta(source).sub, 100 + bw + 8, 64, 20, '#8C8177', 600)

      // 宠物行：头像 136 + 名字 + 性别徽标 + 品种·年龄
      const ac = { x: 112, y: 194, r: 68 }
      this.drawAvatar(ctx, pet, avatar, ac.x, ac.y, ac.r)
      const nx = 206
      const name = this.truncate(ctx, pet.name || '它', 340, 44, 800)
      this.text(ctx, name, nx, 172, 44, '#2C2723', 800)
      if (pet.gender === '公' || pet.gender === '母') {
        const fem = pet.gender === '母'
        ctx.font = `800 44px -apple-system, 'PingFang SC', sans-serif`
        const bx = nx + ctx.measureText(name).width + 14 + 18
        ctx.fillStyle = fem ? '#FFDCE8' : '#DCE9FF'
        ctx.beginPath(); ctx.arc(bx, 172, 18, 0, Math.PI * 2); ctx.fill()
        // ♀♂ 字形 PNG（设计稿同款颜色）；加载失败回落矢量线条（iOS 上 ♀♂ 文字渲染不稳）
        const g = this._iconImgs && this._iconImgs[fem ? 'gender_f' : 'gender_m']
        if (g) {
          ctx.drawImage(g, bx - 13, 172 - 13, 26, 26)
        } else {
          this.drawGender(ctx, bx, 172, fem ? 'f' : 'm', fem ? '#E56A8C' : '#4A7DE0')
        }
      }
      const info = [pet.breed, U.formatAge(pet.birthday)].filter(Boolean).join(' · ')
      if (info) this.text(ctx, this.truncate(ctx, info, 440, 24, 400), nx, 226, 24, '#8C8177')
      return H
    },

    /**
     * 性别符号（矢量）：♀ = 圆 + 竖线 + 横杠；♂ = 圆 + 斜箭 + 箭头两边
     * iOS 上 ♀♂ 字符渲染不稳（emoji 字体兜底导致基线/宽度漂移），别改回文字
     */
    drawGender(ctx, cx, cy, kind, color) {
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 2.2
      ctx.lineCap = 'round'
      if (kind === 'f') {
        ctx.beginPath()
        ctx.arc(cx, cy - 3.5, 5.2, 0, Math.PI * 2)
        ctx.stroke()
        this.line(ctx, cx, cy + 1.7, cx, cy + 9)
        this.line(ctx, cx - 3.2, cy + 6.2, cx + 3.2, cy + 6.2)
      } else {
        ctx.beginPath()
        ctx.arc(cx - 2, cy + 2.5, 5.2, 0, Math.PI * 2)
        ctx.stroke()
        this.line(ctx, cx + 1.5, cy - 1, cx + 7.5, cy - 7)
        this.line(ctx, cx + 2.5, cy - 7, cx + 7.5, cy - 7)
        this.line(ctx, cx + 7.5, cy - 7, cx + 7.5, cy - 2)
      }
    },

    /* ---------- 白色统计卡（压 hero 底部 64px，对齐设计稿 .stats） ---------- */
    drawStats(ctx, opts, y) {
      const pet = opts.pet
      const h = 130
      this.shadow(ctx, 'rgba(150,120,90,.12)', 30, 12)
      ctx.fillStyle = '#fff'
      this.roundRect(ctx, 44, y, W - 88, h, 26)
      ctx.fill()
      this.shadow(ctx)

      const unit = pet.weightUnit || 'kg'
      // 取最新一条（listBy 已按日期倒序）；称重记录优先，无则回落档案体重字段（旧档案 initWeight）
      const ws = (opts && opts.weights) || []
      const initWeight = U.initWeightOf(pet)
      const wv = ws.length ? `${U.fmtWeight(ws[0].value)}${unit}`
        : (initWeight !== null ? `${U.fmtWeight(initWeight)}${unit}` : '暂无')
      const stats = [
        { v: wv, u: '', l: '当前体重' },
        { v: dotDate(pet.birthday) || '—', u: '', l: '生日' },
        { v: dotDate(pet.adoptDay) || '—', u: '', l: '到家日' }
      ]
      const colW = (W - 88) / 3
      stats.forEach((s, i) => {
        const cx = 44 + colW * (i + 0.5)
        // 数字主体 31px + 单位 19px 组合居中（对齐设计稿 .n em）
        ctx.font = `800 31px -apple-system, 'PingFang SC', sans-serif`
        const numW = ctx.measureText(s.v).width
        ctx.font = `800 19px -apple-system, 'PingFang SC', sans-serif`
        const unitW = s.u ? ctx.measureText(s.u).width : 0
        const total = numW + unitW + (s.u ? 3 : 0)
        if (total > colW - 24) {
          this.fitText(ctx, s.v + s.u, cx, y + 47, 31, '#2C2723', 800, 'center', colW - 24)
        } else {
          this.text(ctx, s.v, cx - total / 2, y + 47, 31, '#2C2723', 800)
          if (s.u) this.text(ctx, s.u, cx - total / 2 + numW + 3, y + 50, 19, '#2C2723', 800)
        }
        this.text(ctx, s.l, cx, y + 95, 20, '#8C8177', 400, 'center')
        if (i < 2) {
          ctx.strokeStyle = '#F1E9E1'
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.moveTo(44 + colW * (i + 1), y + 36)
          ctx.lineTo(44 + colW * (i + 1), y + 94)
          ctx.stroke()
        }
      })
      return y + h
    },

    /**
     * 这条记录要画进卡片的已加载图片（最多 IMG_MAX_PER_ROW 张）
     * ⚠️ 私密条目直接返回空：分享长图会脱离小程序传播，私密图绝不能进（红线第 10 条）
     * ⚠️ fileID 在 photoMap 里找不到（加载失败）就跳过，绝不能错位取别的图
     */
    rowImgs(r, photoMap) {
      if (!r || r.visibility === 'private') return []
      const map = photoMap || {}
      return ((r.images) || []).slice(0, IMG_MAX_PER_ROW).map((im) => {
        const id = (im && (im.thumb || im.thumbID || im.full || im.fileID)) || ''
        return id ? map[id] : null
      }).filter((im) => im && im.width)
    },

    /**
     * 卡片内嵌图区：文字区（118 高）下方一排小格，等宽等高，几张画几格
     * 1 张/2 张/3 张都用同一格宽 —— 行高只看「有没有图」，不随张数变，高度计算不会错位
     */
    drawMomentImages(ctx, r, photoMap, yy) {
      const imgs = this.rowImgs(r, photoMap)
      if (!imgs.length) return
      const innerW = CARD_W - IMG_PAD * 2
      const cellW = (innerW - IMG_GAP * (IMG_MAX_PER_ROW - 1)) / IMG_MAX_PER_ROW
      const y = yy + 118 + 12
      imgs.forEach((im, i) => {
        const x = CARD_X + IMG_PAD + i * (cellW + IMG_GAP)
        // 浅底占位：即使图没画出来也不是一块死白
        ctx.fillStyle = '#F6EFE7'
        this.roundRect(ctx, x, y, cellW, IMG_CELL_H, 14)
        ctx.fill()
        if (im && im.width) {
          ctx.save()
          this.roundRect(ctx, x, y, cellW, IMG_CELL_H, 14)
          ctx.clip()
          const iw = im.width || 1
          const ih = im.height || 1
          const s = Math.max(cellW / iw, IMG_CELL_H / ih) // cover：取大比例，短边溢出被裁
          ctx.drawImage(im, x + (cellW - iw * s) / 2, y + (IMG_CELL_H - ih * s) / 2, iw * s, ih * s)
          ctx.restore()
        } else {
          ctx.fillStyle = '#D8CEC4'
          ctx.font = '34px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText('🐾', x + cellW / 2, y + IMG_CELL_H / 2)
        }
      })
    },

    /* ---------- 语义色胶囊 ---------- */
    drawChip(ctx, x, y, label, bg, fg, h, dashed) {
      ctx.font = `700 18px -apple-system, 'PingFang SC', sans-serif`
      const w = ctx.measureText(label).width + 30
      ctx.fillStyle = bg
      this.roundRect(ctx, x, y, w, h, h / 2)
      ctx.fill()
      if (dashed) {
        ctx.strokeStyle = AUTO_CHIP.line
        ctx.lineWidth = 1.5
        ctx.setLineDash && ctx.setLineDash([4, 4])
        this.roundRect(ctx, x, y, w, h, h / 2)
        ctx.stroke()
        ctx.setLineDash && ctx.setLineDash([])
      }
      this.text(ctx, label, x + w / 2, y + h / 2 + 1, 18, fg, 700, 'center')
      return x + w
    },

    /* ---------- 时间线行（对齐设计稿 .mrow：日期列 + 节点圆 + 卡片） ---------- */
    drawRow(ctx, r, yy, first, last, photoMap) {
      const DT_RIGHT = 128          // 日期列右缘（44 + 84）
      const NODE_CX = 182           // 节点圆心（44+84+22+32）
      const CARD_H = 118            // 文字区高度（图区在其下方另加，见 cardH）
      const milestone = r.kind === 'milestone'
      // 带图卡片：文字区下方追加「间距12 + 图格160」——图与文案同卡，不再分离
      const imgs = this.rowImgs(r, photoMap)
      const cardH = CARD_H + (imgs.length ? IMG_EXTRA_H : 0)

      // 日期列：右对齐两行（年 / 月-日，21px 弱化色，对齐设计稿 .mdt）
      // ⚠️ 日期列右缘 128，贯穿线在节点圆心 182，间隔 52px —— 不要把线画回设计稿的 118 位置
      const d = r.date || ''
      this.text(ctx, d.slice(0, 4), DT_RIGHT, yy + 30, 21, '#B6ACA2', 400, 'right')
      this.text(ctx, d.slice(5, 10), DT_RIGHT, yy + 58, 21, '#B6ACA2', 400, 'right')

      // 节点白圆（盖在贯穿线上）+ 类型图标（设计稿同款 emoji 渲染成的 PNG，见 loadNodeIcons）
      this.shadow(ctx, 'rgba(150,120,90,.12)', 16, 6)
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(NODE_CX, yy + 42, 32, 0, Math.PI * 2); ctx.fill()
      this.shadow(ctx)
      const nodeImg = this._iconImgs && this._iconImgs[r.type]
      if (nodeImg) {
        ctx.drawImage(nodeImg, NODE_CX - 19, yy + 42 - 19, 38, 38)
      } else {
        // 兜底：PNG 加载失败才走 emoji 文字（iOS 上 ⚖️🛡️ 可能渲染异常）
        ctx.font = '28px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(NODE_EMOJI[r.type] || '✨', NODE_CX, yy + 43)
      }

      // 卡片
      ctx.fillStyle = milestone ? '#FFFDF9' : '#fff'
      this.shadow(ctx, 'rgba(150,120,90,.09)', 22, 8)
      this.roundRect(ctx, CARD_X, yy, CARD_W, cardH, 22)
      ctx.fill()
      this.shadow(ctx)
      if (milestone) {
        ctx.strokeStyle = '#F0E4D6'
        ctx.lineWidth = 2.5
        this.roundRect(ctx, CARD_X, yy, CARD_W, cardH, 22)
        ctx.stroke()
      }

      // 第一行：名称 + 附加 tag（里程碑 =「里程碑」+「自动记录」两个角标）
      const ix = CARD_X + 26
      const meta = TAG_STYLE[r.type] || TAG_STYLE.daily
      const nm = milestone ? (r.title || meta.label) : (r.type === 'daily' ? (r.title || '日常') : meta.label)
      this.text(ctx, this.truncate(ctx, nm, 200, 27, 800), ix, yy + 36, 27, '#2C2723', 800)
      ctx.font = `800 27px -apple-system, 'PingFang SC', sans-serif`
      let x = ix + ctx.measureText(nm).width + 12
      if (milestone) {
        const msTag = r.type === 'birthday' ? TAG_STYLE.birthday : TAG_STYLE.home
        x = this.drawChip(ctx, x, yy + 20, '里程碑', msTag.bg, msTag.fg, 32) + 10
        // 角标 2：自动记录 —— 中性灰底 + 深灰字 + sparkle，不占语义色（紫已给体检）
        this.drawChip(ctx, x, yy + 20, '✨ 自动记录', AUTO_CHIP.bg, AUTO_CHIP.fg, 32, true)
      } else if (r.type === 'vaccine' && (r.dose || r.title)) {
        this.drawChip(ctx, x, yy + 20, this.truncate(ctx, r.dose || r.title, 160, 18, 700), meta.bg, meta.fg, 32)
      }

      // 描述行（口径见 descOf）：超宽先降级丢副标再截断，保证「下次到期」不被截掉
      const maxDescW = CARD_W - 52
      let ds = this.descOf(r, false)
      ctx.font = `400 22px -apple-system, 'PingFang SC', sans-serif`
      if (ctx.measureText(ds).width > maxDescW) ds = this.descOf(r, true)
      this.text(ctx, this.truncate(ctx, ds, maxDescW, 22, 400), ix, yy + 84, 22, '#8C8177')

      // 图区：画在文字区下方、同一张卡片里 —— 图和它的文案永远在一起
      if (imgs.length) this.drawMomentImages(ctx, r, photoMap, yy)
    },

    /** 描述行文案：nm 已含类型名，这里不再重复 title；brief=true 丢副标（超宽降级用） */
    descOf(r, brief) {
      if (r.kind === 'milestone') {
        // 里程碑描述直接在 derive 阶段由 MS_COPY 映射表产出（含变量代入），
        // 这里不再拼「来自档案 + 日期」—— 日期已显示在卡片右上角，复述即违规
        return r.desc || '—'
      }
      if (r.type === 'vaccine' || r.type === 'dewormIn' || r.type === 'dewormOut' || r.type === 'checkup') {
        let s = brief ? (r.desc || '') : [r.sub, r.desc].filter(Boolean).join(' · ')
        if (r.cost > 0) s += (s ? ' · ' : '') + `¥${U.fen2yuan(r.cost)}`
        if (r.nextDate) s += (s ? ' · ' : '') + `下次 ${r.nextDate}`
        return s || '—'
      }
      if (r.type === 'weight') {
        // 体重：title 已是「6.5kg」数值形态，desc 是「比上次±x」
        return [r.title, r.desc].filter(Boolean).join(' · ') || '—'
      }
      return r.desc || r.sub || '—'
    },

    /* ---------- 页脚（Logo 图 + 三行文案，行距 ≥30/≥20） ---------- */
    drawFooter(ctx, y, logo) {
      const H = 240
      ctx.fillStyle = '#FFFCF7'
      ctx.fillRect(0, y, W, H)
      ctx.strokeStyle = '#F1E9E1'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y + 0.5)
      ctx.lineTo(W, y + 0.5)
      ctx.stroke()
      // 官方 Logo 88x88；加载失败回落渐变圆角块 + 白爪印路径
      if (logo && logo.width) {
        ctx.drawImage(logo, W / 2 - 44, y + 26, 88, 88)
      } else {
        const lg = { x: W / 2 - 44, y: y + 26, s: 88 }
        const grad = ctx.createLinearGradient(lg.x, lg.y, lg.x + lg.s, lg.y + lg.s)
        grad.addColorStop(0, '#FFA94D')
        grad.addColorStop(1, '#FF6E22')
        ctx.fillStyle = grad
        this.roundRect(ctx, lg.x, lg.y, lg.s, lg.s, 26)
        ctx.fill()
        this.drawPaw(ctx, W / 2, lg.y + 24, '#FFFFFF')
      }
      this.text(ctx, '它的时光', W / 2, y + 146, 30, '#2C2723', 800, 'center')
      this.text(ctx, '认真记下它的每一天', W / 2, y + 182, 19, '#B6ACA2', 400, 'center')
      // 署名：未设置昵称不显示该行（不留空占位）
      const nickname = store.getUser().nickname
      if (nickname) {
        this.text(ctx, `@${nickname} 的毛孩子`, W / 2, y + 214, 21, '#8C8177', 400, 'center')
      }
      return y + H
    },

    /** 页脚 Logo 回落用的路径爪印（44x40，主橙 #F7934F，与页面 timeline-item 同构） */
    drawPaw(ctx, cx, top, color) {
      ctx.fillStyle = color || '#F7934F'
      const left = cx - 22
      const toes = [[7.5, 14], [17.5, 6], [26.5, 6], [36.5, 14]]
      toes.forEach((t) => this.ellipse(ctx, left + t[0], top + t[1], 4.5, 6))
      this.roundRect(ctx, cx - 12, top + 21, 24, 19, 9.5)
      ctx.fill()
    },
    /** 椭圆：只用 translate+scale+arc，避开部分真机 ctx.ellipse 兼容问题 */
    ellipse(ctx, cx, cy, rx, ry) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(rx / ry, 1)
      ctx.beginPath()
      ctx.arc(0, 0, ry, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    },

    /* ---------- 成长时间线版式 ---------- */
    drawTimeline(ctx, opts, H, avatar, logo, photoMap) {
      ctx.fillStyle = '#FDF8F2'
      ctx.fillRect(0, 0, W, H)
      this.drawHero(ctx, opts.pet, avatar, logo, 'timeline')
      this.drawStats(ctx, opts, 288)

      const list = opts.records.slice(0, 12)
      const y0 = 464
      const NODE_CX = 182
      const NODE_CY = 42 // 节点圆心相对行顶

      // 贯穿竖线：画在节点圆心（x=182，日期列右缘 128，间隔 52px —— 避开设计稿线贴日期的问题）
      // ⚠️ 行高随「这条有没有图」变化，节点圆心必须逐行累加，不能用固定 ROW × i
      if (list.length > 1) {
        ctx.strokeStyle = '#F1E9E1'
        ctx.lineWidth = 4
        ctx.beginPath()
        let cy = y0 + NODE_CY
        ctx.moveTo(NODE_CX, cy)
        for (let i = 1; i < list.length; i++) {
          cy += this.rowH(list[i - 1], photoMap)
          ctx.lineTo(NODE_CX, cy)
        }
        ctx.stroke()
      }
      let y = y0
      list.forEach((r, i) => {
        this.drawRow(ctx, r, y, i === 0, i === list.length - 1, photoMap)
        y += this.rowH(r, photoMap)
      })
      this.drawFooter(ctx, y + 40, logo)
    },

    /* ---------- 卡片版式（vaccine / health 共用，文案与配色由版式配置决定） ---------- */
    drawCards(ctx, opts, H, avatar, logo) {
      const meta = srcMeta(opts.source)
      ctx.fillStyle = '#FDF8F2'
      ctx.fillRect(0, 0, W, H)
      this.drawHero(ctx, opts.pet, avatar, logo, opts.source)
      let y = this.drawStats(ctx, opts, 288)
      y += 20
      // 徽标
      ctx.fillStyle = '#FF7A2F'
      this.roundRect(ctx, W / 2 - 190, y, 380, 64, 32)
      ctx.fill()
      this.text(ctx, meta.badge(opts.records.length), W / 2, y + 32, 24, '#fff', 700, 'center')
      y += 64 + 32

      const list = opts.records.slice(0, 8)
      list.forEach((r) => {
        const ch = 156
        ctx.fillStyle = '#fff'
        this.roundRect(ctx, 44, y, W - 88, ch, 24)
        ctx.fill()
        // 卡片圆点按记录类型取语义色：疫苗蓝 / 驱虫绿 / 体检紫
        const t = TAG_STYLE[r.type] || TAG_STYLE.daily
        ctx.fillStyle = t.bg
        ctx.beginPath(); ctx.arc(86, y + 44, 22, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = t.fg
      ctx.beginPath(); ctx.arc(86, y + 44, 8, 0, Math.PI * 2); ctx.fill()

      // 标题：优先用已装饰的 nameText（含类型名回落），兼容原始记录
      this.text(ctx, this.truncate(ctx, r.nameText || r.name || t.label, 300, 30, 800), 124, y + 40, 30, '#2C2723', 800)

      // 针次胶囊：仅疫苗有
        if (r.type === 'vaccine' && r.dose) {
          ctx.fillStyle = t.bg
          this.roundRect(ctx, 124, y + 62, 110, 36, 999)
          ctx.fill()
          this.text(ctx, r.dose, 179, y + 81, 20, t.fg, 700, 'center')
        }
        this.text(ctx, dotDate(r.date), W - 66, y + 44, 22, '#B6ACA2', 400, 'right')
        // 第二行：有下次日期显示「下次接种/驱虫/体检」，否则回落备注
        const nextLabel = r.subLabel
          || (r.type === 'vaccine' ? '下次接种' : r.type === 'checkup' ? '下次体检' : '下次驱虫')
        this.text(ctx, r.nextDate ? nextLabel : '备注', 124, y + 126, 22, '#8C8177')
        this.text(ctx, this.truncate(ctx, dotDate(r.nextDate) || r.note || '—', 420, 22, 600), W - 66, y + 126, 22, '#2C2723', 600, 'right')
        y += ch + 22
      })
      // 保护语
      ctx.fillStyle = '#FFF0E4'
      this.roundRect(ctx, 44, y, W - 88, 88, 24)
      ctx.fill()
      ctx.font = '34px sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(meta.tip.ic, 74, y + 44)
      this.text(ctx, meta.tip.text, 130, y + 44, 24, '#F2600A', 700)
      this.drawFooter(ctx, y + 120, logo)
    },

    /* ---------- 保存 / 分享 ---------- */
    onSave() {
      const fp = this.data.filePath
      if (!fp) return
      wx.saveImageToPhotosAlbum({
        filePath: fp,
        success: () => U.toast('已保存到相册'),
        fail: (e) => {
          if (e && /auth/.test(e.errMsg || '')) {
            wx.showModal({ title: '需要相册权限', content: '请在设置中允许保存到相册' })
          }
        }
      })
    },
    onShare() {
      const fp = this.data.filePath
      if (!fp) return
      wx.showShareImageMenu({
        path: fp,
        fail: () => {
          // 低版本微信分享不可用 → 降级保存相册（PRD 模块 6 验收）
          this.onSave()
          U.toast('当前版本不支持直接分享，已为你保存到相册')
        }
      })
    }
  }
})
