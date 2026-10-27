/**
 * recommend-card · 推荐好友分享封面（对齐设计稿《分享卡片-推荐好友》5:4 版）
 *
 * 卡面规格：750×600（5:4）—— 设计稿 375×300 的 2 倍
 *   暖橙渐变铺底（CSS 148deg → 画布左上到右下）
 *   品牌行：Logo 42px（橙渐变圆角方块 + 白色爪印）+「它的时光」800/27 → #8A5A2E
 *   主文案两行 46/800 → #3A2A1C「把毛孩子的每一天，/ 都记下来」
 *   副文案 25 → #A9805B「疫苗驱虫提醒 · 成长时间线 · 养宠花销」
 *   底部 chip（白 78% 底 + 勾 + #B1531A 文字）+ 右侧「宠物成长记录」
 *   右下爪印装饰（#B1531A / 14% / -14°）+ 两个白色装饰圆点
 *
 * 用法：页面放 <recommend-card id="recommendCard" />，在 onShareAppMessage 里
 *       const imageUrl = await this.selectComponent('#recommendCard').generate()
 *
 * ⚠️ 卡面是静态内容（不含头像 / 宠物名 / 昵称），生成一次即缓存，避免每次转发重复出图
 * ⚠️ canvasToTempFilePath 真机存在「既不 success 也不 fail」，必须加超时兜底
 */
const U = require('../../utils/util')

const W = 750
const H = 600

/* ---------- 版式常量（设计稿 CSS px × 2） ---------- */
const PAD_X = 52 // 26
const PAD_T = 48 // 24
const PAD_B = 44 // 22
const LOGO = 42 // 21
const BRAND_GAP = 12 // 6
const BRAND_FS = 27 // 13.5
const BRAND_LS = 1.2 // .6
const MAIN_GAP = 88 // 44（品牌行底 → 主文案顶）
const MAIN_FS = 46 // 23
const MAIN_LH = 62 // 1.34 × 46
const SUB_FS = 25 // 12.5
const SUB_GAP = 22 // 11
const CHIP_H = 52 // (11.5×1.2 + 12) × 2
const CHIP_FS = 23 // 11.5
const CHIP_PAD = 24 // 12
const TAIL_FS = 22 // 11

const BRAND = '它的时光'
const MAIN_LINES = ['把毛孩子的每一天，', '都记下来']
const SUB_TEXT = '疫苗驱虫提醒 · 成长时间线 · 养宠花销'
const CHIP_TEXT = '无需注册 · 打开即用'
const TAIL_TEXT = '宠物成长记录'

const FONT = (w, s) => `${w} ${s}px -apple-system, 'PingFang SC', sans-serif`

/* ---------- 绘制基元 ---------- */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

function ellipsePath(ctx, cx, cy, rx, ry, deg) {
  const rot = ((deg || 0) * Math.PI) / 180
  ctx.beginPath()
  if (ctx.ellipse) {
    ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2)
  } else {
    // 老基础库兜底：缩放到单位圆
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rot)
    ctx.scale(rx, ry)
    ctx.arc(0, 0, 1, 0, Math.PI * 2)
    ctx.restore()
  }
  ctx.fill()
}

Component({
  methods: {
    /**
     * 生成分享封面图
     * @returns {Promise<string>} 临时文件路径；失败返回 ''（调用方不传 imageUrl，用页面默认截图）
     */
    async generate() {
      // 缓存命中也要验一下文件还在（微信会回收临时文件，失效后分享卡会显示空白）
      if (this._path && await this.exists(this._path)) return this._path
      this._path = ''
      try {
        // 微信转发对异步 onShareAppMessage 有等待上限，超时宁可回落默认截图
        const guard = new Promise((resolve) => setTimeout(() => resolve(''), 2200))
        const path = await Promise.race([this.draw(), guard])
        if (path) this._path = path
        return path
      } catch (e) {
        console.warn('[recommend-card] 生成失败', e)
        return ''
      }
    },

    /** 本地临时文件是否还在（access 不回调时按「不在」处理，让它重新出图） */
    exists(path) {
      return new Promise((resolve) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        setTimeout(() => finish(false), 400)
        try {
          wx.getFileSystemManager().access({ path, success: () => finish(true), fail: () => finish(false) })
        } catch (e) {
          finish(false)
        }
      })
    },

    draw() {
      return new Promise((resolve) => {
        const q = this.createSelectorQuery()
        q.select('#recommendCanvas').fields({ node: true, size: true }).exec((res) => {
          const node = res && res[0] && res[0].node
          if (!node) return resolve('')

          const dpr = U.getUI().dpr || 2
          node.width = W * dpr
          node.height = H * dpr
          const ctx = node.getContext('2d')
          ctx.scale(dpr, dpr)

          try {
            this.paint(ctx)
          } catch (e) {
            console.warn('[recommend-card] 绘制异常', e)
            return resolve('')
          }

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

    /* ---------- 卡面 ---------- */
    paint(ctx) {
      // 1) 暖橙渐变底（148deg ≈ 左上 → 右下）
      const bg = ctx.createLinearGradient(0, 0, W * 0.53, H * 0.85)
      bg.addColorStop(0, '#FFCB9C')
      bg.addColorStop(0.46, '#FFE7CF')
      bg.addColorStop(1, '#FDF8F2')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, W, H)

      // 2) 右下爪印装饰（压在文字下层；设计稿 right:-26px / bottom:-30px，尺寸 168px → 2 倍 336）
      const PAW_BOX = 336
      this.drawPaw(ctx, W + 52 - PAW_BOX, H + 60 - PAW_BOX, PAW_BOX, '#B1531A', 0.14, -14)

      // 3) 白色装饰圆点
      ctx.fillStyle = 'rgba(255,255,255,.5)'
      ellipsePath(ctx, W - 92 - 9, 68 + 9, 9, 9, 0)
      ellipsePath(ctx, W - 60 - 5, 104 + 5, 5, 5, 0)

      // 4) 品牌行
      this.drawLogo(ctx, PAD_X, PAD_T, LOGO)
      this.textLS(ctx, BRAND, PAD_X + LOGO + BRAND_GAP, PAD_T + LOGO / 2, BRAND_FS, '#8A5A2E', 800, BRAND_LS)

      // 5) 主文案（固定两行，不自动换行——设计稿断句就是语义断句）
      const mainTop = PAD_T + LOGO + MAIN_GAP
      MAIN_LINES.forEach((line, i) => {
        this.text(ctx, line, PAD_X, mainTop + MAIN_LH / 2 + i * MAIN_LH, MAIN_FS, '#3A2A1C', 800)
      })

      // 6) 副文案
      const subTop = mainTop + MAIN_LH * MAIN_LINES.length + SUB_GAP
      this.text(ctx, SUB_TEXT, PAD_X, subTop + SUB_FS * 0.62, SUB_FS, '#A9805B', 400)

      // 7) 底部：chip + 右侧尾巴
      const chipTop = H - PAD_B - CHIP_H
      const cy = chipTop + CHIP_H / 2
      const iconSize = 22
      ctx.font = FONT(700, CHIP_FS)
      const textW = ctx.measureText(CHIP_TEXT).width
      const chipW = CHIP_PAD * 2 + iconSize + 10 + textW
      ctx.fillStyle = 'rgba(255,255,255,.78)'
      roundRectPath(ctx, PAD_X, chipTop, chipW, CHIP_H, CHIP_H / 2)
      ctx.fill()

      // 勾（SVG path M5 12.5l4.5 4.5L19 7，按 24 网格缩放到 22px）
      const ic = iconSize / 24
      const ix = PAD_X + CHIP_PAD
      const iy = cy - iconSize / 2
      ctx.beginPath()
      ctx.moveTo(ix + 5 * ic, iy + 12.5 * ic)
      ctx.lineTo(ix + 9.5 * ic, iy + 17 * ic)
      ctx.lineTo(ix + 19 * ic, iy + 7 * ic)
      ctx.strokeStyle = '#E06A1B'
      ctx.lineWidth = 2.4 * ic
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()

      this.text(ctx, CHIP_TEXT, ix + iconSize + 10, cy, CHIP_FS, '#B1531A', 700)

      // 右侧尾巴：「宠物成长记录」与 chip 同基线
      this.text(ctx, TAIL_TEXT, W - PAD_X, cy, TAIL_FS, '#A9805B', 700, 'right')
    },

    /** Logo：橙渐变圆角方块 + 白色爪印（几何取自设计稿 SVG，1024 网格） */
    drawLogo(ctx, x, y, size) {
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(size / 1024, size / 1024)

      const g = ctx.createLinearGradient(0, 0, 1024, 1024)
      g.addColorStop(0, '#FFA94D')
      g.addColorStop(1, '#FF6E22')
      roundRectPath(ctx, 0, 0, 1024, 1024, 228)
      ctx.fillStyle = g
      ctx.fill()
      ctx.clip()

      // 组变换：translate(512,512) scale(1.25) translate(-512,-506)
      ctx.translate(512, 512)
      ctx.scale(1.25, 1.25)
      ctx.translate(-512, -506)

      ctx.fillStyle = '#FFFFFF'
      ellipsePath(ctx, 300, 468, 70, 90, -20)
      ellipsePath(ctx, 432, 372, 74, 96, -7)
      ellipsePath(ctx, 592, 372, 74, 96, 7)
      ellipsePath(ctx, 724, 468, 70, 90, 20)
      roundRectPath(ctx, 368, 556, 288, 176, 56)
      ctx.fill()

      // 掌心里的两道橙色纹路
      ctx.fillStyle = '#FF7A2F'
      roundRectPath(ctx, 408, 606, 208, 20, 10)
      ctx.fill()
      roundRectPath(ctx, 408, 672, 140, 20, 10)
      ctx.fill()
      ctx.restore()
    },

    /** 爪印装饰：viewBox 24 网格 → box 像素，整体旋转 deg（绕自身中心） */
    drawPaw(ctx, left, top, box, color, alpha, deg) {
      const f = box / 24
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.translate(left + box / 2, top + box / 2)
      ctx.rotate((deg * Math.PI) / 180)
      ctx.translate(-12 * f, -12 * f)
      ellipsePath(ctx, 12 * f, 16.8 * f, 5.4 * f, 4.4 * f, 0)
      ellipsePath(ctx, 4.9 * f, 10.6 * f, 2.3 * f, 3 * f, -20)
      ellipsePath(ctx, 9.4 * f, 7.4 * f, 2.4 * f, 3.2 * f, -7)
      ellipsePath(ctx, 14.6 * f, 7.4 * f, 2.4 * f, 3.2 * f, 7)
      ellipsePath(ctx, 19.1 * f, 10.6 * f, 2.2 * f, 3 * f, 20)
      ctx.restore()
    },

    /* ---------- 文字 ---------- */
    text(ctx, str, x, y, size, color, weight, align) {
      ctx.font = FONT(weight || 400, size)
      ctx.fillStyle = color
      ctx.textAlign = align || 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(str, x, y)
    },
    /** 带字距的文字（canvas letterSpacing 兼容性不稳，逐字排） */
    textLS(ctx, str, x, y, size, color, weight, ls) {
      ctx.font = FONT(weight || 400, size)
      ctx.fillStyle = color
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      let cx = x
      for (const ch of str) {
        ctx.fillText(ch, cx, y)
        cx += ctx.measureText(ch).width + ls
      }
    }
  }
})
