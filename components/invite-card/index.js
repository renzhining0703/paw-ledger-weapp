/**
 * invite-card · 邀请分享卡片生图（对齐设计稿《分享卡片-微信会话》）
 *
 * 卡面规格：750×600（5:4），暖橙渐变铺底
 *   白色圆形头像（有头像用真头像，无头像用物种 emoji）
 *   → 宠物名（白色 800）
 *   → 「{邀请人} 邀请你一起记录」（半透明白）
 *   → 右下角水印「它的时光」
 *
 * 用法：页面放 <invite-card id="inviteCard" />，在 onShareAppMessage 里
 *       const imageUrl = await this.selectComponent('#inviteCard').generate({ pet, inviterName })
 *
 * ⚠️ 头像：cloud:// 必须先换临时 https，canvas 不能直读 fileID（share-pop 已踩过）
 * ⚠️ Image 必须挂 this._img 保引用，局部变量会在异步解码期间被回收（项目已踩过）
 * ⚠️ canvasToTempFilePath 真机存在「既不 success 也不 fail」，必须加超时兜底
 */
const U = require('../../utils/util')
const config = require('../../utils/config')

const W = 750
const H = 600

/** 物种 emoji：单一数据源 config.SPECIES（无头像时的卡面头像兜底） */
const EMOJI = config.SPECIES.reduce((m, s) => { m[s.key] = s.emoji; return m }, {})

Component({
  methods: {
    /**
     * 生成邀请卡片图
     * @param {{pet: object, inviterName?: string}} opts
     * @returns {Promise<string>} 临时文件路径；失败返回 ''（调用方回落到头像图）
     */
    async generate(opts) {
      const pet = (opts && opts.pet) || {}
      const inviterName = ((opts && opts.inviterName) || '').trim()
      const key = [pet._id, pet.name, pet.avatar, pet.species, inviterName].join('|')
      if (this._cacheKey === key && this._cachePath) return this._cachePath

      try {
        // 整体 2.2s 保护：微信转发对异步 onShareAppMessage 有等待上限，
        // 超时就回落头像图，绝不能让分享按钮「点了没反应」
        const guard = new Promise((resolve) => setTimeout(() => resolve(''), 2200))
        const path = await Promise.race([this.draw(pet, inviterName), guard])
        if (path) {
          this._cacheKey = key
          this._cachePath = path
        }
        return path
      } catch (e) {
        console.warn('[invite-card] 生成失败', e)
        return ''
      }
    },

    draw(pet, inviterName) {
      return new Promise((resolve) => {
        const q = this.createSelectorQuery()
        q.select('#inviteCanvas').fields({ node: true, size: true }).exec(async (res) => {
          const node = res && res[0] && res[0].node
          if (!node) return resolve('')

          const dpr = U.getUI().dpr || 2
          node.width = W * dpr
          node.height = H * dpr
          const ctx = node.getContext('2d')
          ctx.scale(dpr, dpr)

          const avatar = await this.loadAvatar(node, pet)
          this.paint(ctx, pet, inviterName, avatar)

          // 真机兜底：导出既不回调 success 也不回调 fail 时按失败处理
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            resolve('')
          }, 1200)
          wx.canvasToTempFilePath({
            canvas: node,
            destWidth: W,
            destHeight: H,
            success: (r) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(r.tempFilePath || '')
            },
            fail: () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve('')
            }
          }, this)
        })
      })
    },

    /** 头像：cloud:// → 临时 https；加载失败返回 null（回落物种 emoji） */
    loadAvatar(node, pet) {
      const raw = (pet && pet.avatar) || ''
      if (!raw || typeof node.createImage !== 'function') return Promise.resolve(null)
      return new Promise((resolve) => {
        U.petShareImage(pet).then((src) => {
          if (!src) return resolve(null)
          try {
            const img = node.createImage()
            this._img = img // 保引用，防异步解码期间被回收
            let done = false
            const finish = (v) => { if (!done) { done = true; resolve(v) } }
            img.onload = () => finish(img)
            img.onerror = () => finish(null)
            img.src = src
            setTimeout(() => finish(null), 1200)
          } catch (e) { resolve(null) }
        }).catch(() => resolve(null))
      })
    },

    /* ---------- 绘制 ---------- */
    paint(ctx, pet, inviterName, avatar) {
      // 1) 暖橙渐变底（左上浅 → 右下深，对齐设计稿卡面）
      const bg = ctx.createLinearGradient(0, 0, W, H)
      bg.addColorStop(0, '#FFC79A')
      bg.addColorStop(0.55, '#FFAB6E')
      bg.addColorStop(1, '#FF9552')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)

      // 顶部柔光，让头像区亮起来
      const glow = ctx.createRadialGradient(W / 2, 130, 30, W / 2, 130, 430)
      glow.addColorStop(0, 'rgba(255,255,255,.38)')
      glow.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, W, H)

      // 2) 白色圆形头像
      const cx = W / 2
      const cy = 200
      const r = 116
      ctx.save()
      ctx.shadowColor = 'rgba(196,104,44,.26)'
      ctx.shadowBlur = 34
      ctx.shadowOffsetY = 14
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      if (avatar && avatar.width) {
        // 真头像：圆形裁切 + cover 填充
        const ir = r - 6
        ctx.save()
        ctx.beginPath()
        ctx.arc(cx, cy, ir, 0, Math.PI * 2)
        ctx.clip()
        const iw = avatar.width || 1
        const ih = avatar.height || 1
        const s = Math.max((ir * 2) / iw, (ir * 2) / ih)
        ctx.drawImage(avatar, cx - (iw * s) / 2, cy - (ih * s) / 2, iw * s, ih * s)
        ctx.restore()
      } else {
        // 无头像：物种 emoji（与宠物档案占位同源）
        ctx.font = '118px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(EMOJI[pet.species] || '🐾', cx, cy + 8)
      }

      // 3) 宠物名（超长自动缩字号，不截断宠物名）
      const name = pet.name || '它'
      this.fitText(ctx, name, cx, 392, 62, '#FFFFFF', 800, 'center', 580)

      // 4) 邀请语
      const sub = inviterName ? `${inviterName} 邀请你一起记录` : '邀请你一起记录'
      this.text(ctx, this.truncate(ctx, sub, 580, 30, 500), cx, 456, 30, 'rgba(255,255,255,.92)', 500, 'center')

      // 5) 右下角水印（合规：只留品牌名，不放任何联系方式）
      this.text(ctx, '它的时光', W - 44, H - 36, 26, 'rgba(255,255,255,.66)', 600, 'right')
    },

    /* ---------- 绘制基元 ---------- */
    text(ctx, str, x, y, size, color, weight, align) {
      ctx.font = `${weight || 400} ${size}px -apple-system, 'PingFang SC', sans-serif`
      ctx.fillStyle = color
      ctx.textAlign = align || 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(str, x, y)
    },
    /** 超宽时缩小字号（宠物名优先完整显示） */
    fitText(ctx, str, x, y, size, color, weight, align, maxW) {
      let s = size
      ctx.font = `${weight || 400} ${s}px -apple-system, 'PingFang SC', sans-serif`
      while (s > 30 && ctx.measureText(str).width > maxW) {
        s -= 2
        ctx.font = `${weight || 400} ${s}px -apple-system, 'PingFang SC', sans-serif`
      }
      this.text(ctx, str, x, y, s, color, weight, align)
    },
    truncate(ctx, str, maxW, size, weight) {
      ctx.font = `${weight || 400} ${size}px -apple-system, 'PingFang SC', sans-serif`
      if (ctx.measureText(str).width <= maxW) return str
      let s = str
      while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1)
      return s + '…'
    }
  }
})
