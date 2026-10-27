/**
 * avatar-cropper：头像裁剪弹层（拖动调整位置 + 双指缩放）
 *
 * 交互（市面主流头像裁剪）：
 * - 选图后进入全屏取景，圆形取景框内即最终头像，框外压暗
 * - 单指拖动改位移，双指捏合改缩放；每次移动后按「图片必须铺满取景框」收边界，
 *   拖不出黑边，也不会缩到比取景框小
 *
 * 导出：按取景框区域画到 2d canvas，导出正方形 jpg 临时路径并回传 confirm；
 *      云存储上传仍由页面负责（保持单一写库口）
 *
 * ⚠️ 踩坑 1：临时路径要先规整。
 *    iOS 上 wx.chooseMedia 返回的是 http://tmp/xxx.png 这类内部链接，
 *    新版基础库已不支持 HTTP 图片链接 —— <image> 和 canvas.createImage() 都会失败。
 *    必须先用 getImageInfo 回传的 path（wxfile://...）替换，不行再落盘到 USER_DATA_PATH。
 *
 * ⚠️ 踩坑 2：canvas.createImage() 返回的 Image 必须留强引用（挂在 this 上）。
 *    只用局部变量时，异步解码期间对象可能被回收 → onload/onerror 永不回调，
 *    表现就是「点使用没反应」（无 toast、不关闭、不出图）。
 *    本项目 share-pop 之所以没踩到，是因为它 resolve(img) 让 pending promise 一直持有引用。
 *
 * 确认链路三道兜底，任何一环出问题都不会停在「没反应」：
 * 1. 点「使用」立刻 showLoading，用户能看到点击已生效
 * 2. 等图片就绪带超时（8s），超时即走兜底
 * 3. 导出失败 / 图片加载失败 → 回传原始图（fallback: true），页面照常换头像
 *
 * 关闭协议同 bottom-sheet（防 observers 对相同值也触发导致的同步死循环）：
 * - 用户点「取消 / 使用」→ beginClose(true) 回传 close
 * - 父级直接置 show=false → observer 里 beginClose(false) 只做 UI 收尾，不回传事件
 * - closing 期间重复触发一律忽略
 */
const U = require('../../utils/util')

/** 取景框左右留白 / 底部操作区预留（px） */
const SIDE = 40
const BOTTOM = 200
/** 相对「刚好铺满」的最大放大倍数 */
const MAX_ZOOM = 4
/** 等图片就绪的超时（ms）：超时即回落原图，绝不无限挂起 */
const IMG_TIMEOUT = 8000

const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 })

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    show: { type: Boolean, value: false },
    /** 待裁剪的本地临时路径 */
    src: { type: String, value: '' },
    /** 导出边长（px，正方形） */
    outSize: { type: Number, value: 400 }
  },

  data: {
    render: false,
    closing: false,
    ready: false,
    /** 正在导出（防重复点击「使用」） */
    busy: false,
    /** 取景框（px）：x/y 左上角、s 边长 */
    frame: { x: 0, y: 0, s: 0 },
    /** 原图自然尺寸（px），图片元素按此尺寸渲染后再套 transform */
    iw: 0,
    ih: 0,
    /** 预览用路径：取规整后的本地路径（src 可能是 http://tmp/... ，不可用） */
    disp: '',
    /** 图片落位（px）：left/top 左上角、w/h 显示尺寸 */
    img: { left: 0, top: 0, w: 0, h: 0 }
  },

  observers: {
    show(v) {
      if (v) {
        clearTimeout(this._t)
        this.setData({ render: true, closing: false })
        // 每次打开都重新载入，清掉上次的拖动/缩放
        this._loadedSrc = null
        this.tryLoad()
      } else if (this.data.render && !this.data.closing) {
        // 父级已把 show 置 false：只做 UI 收尾，不回传事件（防回环）
        this.beginClose(false)
      }
    },
    src() { this.tryLoad() }
  },

  lifetimes: {
    attached() {
      // 版本信标：打开编辑档案页时必打印。没有它 = 工具在跑旧代码，先解决编译再谈其他
      console.log('[avatar-cropper] attached, build=20261023-d')
    },
    detached() {
      clearTimeout(this._t)
      this.cleanSaved()
    }
  },

  methods: {
    noop() {},

    /** 事件链路诊断日志：排障期打印触摸起点/类型/目标，定位「点击没反应」断在哪一环 */
    logEvt(tag, e) {
      const t = e && e.touches && e.touches[0]
      const tgt = e && e.target
      const act = tgt && tgt.dataset && tgt.dataset.act
      console.log('[avatar-cropper]', tag, (e && e.type) || '', t ? ('@' + Math.round(t.clientX) + ',' + Math.round(t.clientY)) : '', act ? ('act=' + act) : '')
    },

    /** 只有「已显示 + 有图 + 未加载过」才真正读图，避免 observer 重复触发带来的重复加载 */
    tryLoad() {
      const src = this.data.src
      if (!this.data.render || !src || this._loadedSrc === src) return
      // load 内部已全量兜底，这里再兜一层，确保 observer 不会因为异常被中断
      Promise.resolve(this.load(src)).catch((e) => {
        console.error('[avatar-cropper] load 异常', e)
        U.toast('读取图片失败')
        this.beginClose(true)
      })
    },

    /**
     * 读图片：先规整成本地路径，再取尺寸
     * @returns {{path: string, width: number, height: number} | null}
     */
    async readImage(src) {
      const isHttp = (p) => /^http:\/\//i.test(p || '')
      // http://tmp/... 这类链接基础库已不支持（<image> 与 canvas 都加载不了），
      // 优先落盘换成本地 wxfile:// 路径；失败就沿用原始链接，不阻断流程
      const local = isHttp(src) ? await this.toLocal(src) : ''
      const cands = [local, src].filter((p, i, a) => !!p && a.indexOf(p) === i)
      for (const p of cands) {
        const info = await this.getInfo(p)
        if (info && info.width && info.height) {
          // getImageInfo 回传的本地路径优先，仍是 http 就用当前候选
          return { path: info.path && !isHttp(info.path) ? info.path : p, width: info.width, height: info.height }
        }
      }
      console.error('[avatar-cropper] 所有候选路径都读不到尺寸', cands)
      return null
    },

    /** 给任意 promise 加超时：真机上个别 API 可能不回调，必须有兜底，否则整个流程挂死 */
    withTimeout(promise, ms, fallback) {
      let timer
      return Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
      ]).then((v) => {
        clearTimeout(timer)
        return v
      })
    },

    /** 读原图尺寸；读不到返回 null（保证不抛异常） */
    getInfo(src) {
      return this.withTimeout(new Promise((resolve) => {
        try {
          wx.getImageInfo({ src, success: resolve, fail: () => resolve(null) })
      } catch (e) {
        console.error('[avatar-cropper] getImageInfo 异常', e)
        resolve(null)
      }
      }), 5000, null)
    },

    /** 清掉为规整路径而落盘的副本（只清自己当前持有的那个；历史副本在 toLocal 换新时已顺手清） */
    cleanSaved() {
      const p = this._saved
      if (!p) return
      this._saved = null
      try {
        wx.getFileSystemManager().unlink({ filePath: p, success: () => {}, fail: () => {} })
      } catch (e) { /* 环境不支持则忽略 */ }
    },

    /**
     * 落盘换本地路径：优先 copyFile（保留临时文件），失败再用 saveFile（移动临时文件）
     * 任何一步失败都返回原始链接，由调用方继续兜底，绝不阻断流程
     *
     * ⚠️ 副本必须用唯一文件名（时间戳）：固定名覆盖后，<image> / canvas.createImage
     *    对本地路径有缓存，路径不变就继续显示上一张图（已踩：二次选图裁剪框还是旧图）。
     *    上一次的副本在落新盘前顺手清掉，不累积占存储。
     */
    async toLocal(src) {
      try {
        const base = wx.env && wx.env.USER_DATA_PATH
        const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null
        if (!base || !fs) return src
        const target = `${base}/avatar_src_${Date.now()}.png`

        // 清上一次的副本（本次成功后 _saved 会指向新文件）
        const prev = this._saved
        this._saved = null
        if (prev) {
          try { fs.unlink({ filePath: prev, success: () => {}, fail: () => {} }) } catch (e) { /* 忽略 */ }
        }

        const copied = await this.withTimeout(new Promise((resolve) => {
          try {
            fs.copyFile({
              srcPath: src,
              destPath: target,
              success: () => resolve(true),
              fail: (e) => { console.warn('[avatar-cropper] copyFile 失败，改用 saveFile', e); resolve(false) }
            })
          } catch (e) { resolve(false) }
        }), 5000, false)
        if (copied) { this._saved = target; return target }

        const saved = await this.withTimeout(new Promise((resolve) => {
          try {
            fs.saveFile({
              tempFilePath: src,
              filePath: target,
              success: () => resolve(true),
              fail: (e) => { console.error('[avatar-cropper] saveFile 失败', e); resolve(false) }
            })
          } catch (e) { resolve(false) }
        }), 5000, false)
        if (saved) { this._saved = target; return target }

        return src
      } catch (e) {
        console.error('[avatar-cropper] 路径规整失败，沿用原路径', e)
        return src
      }
    },

    /** 读原图 → 按 cover 铺满取景框 → 居中 → 取画布节点并预载图片 */
    async load(src) {
      this._loadedSrc = src
      this._img = null
      this._imgReady = null
      this._resolveImg = null
      // 清掉上一张的预览路径：image 是 wx:if disp 控制的，不清会闪现上一张图
      this.setData({ ready: false, busy: false, disp: '' })

      let meta = null
      try {
        meta = await this.readImage(src)
      } catch (e) {
        console.error('[avatar-cropper] readImage 异常', e)
      }
      if (!meta) {
        U.toast('读取图片失败')
        this.beginClose(true)
        return
      }
      // 后续预览与绘制统一用规整后的本地路径（http://tmp/... 已不可用）
      this._src = meta.path
      const ui = U.getUI()
      const s = Math.max(120, ui.windowWidth - SIDE * 2)
      this._frame = {
        x: Math.round((ui.windowWidth - s) / 2),
        y: Math.max(SIDE, Math.round((ui.windowHeight - BOTTOM - s) / 2)),
        s
      }
      this._iw = meta.width
      this._ih = meta.height
      // 基准缩放：图片恰好铺满取景框（cover），初始位移为 0
      this._fit = Math.max(s / meta.width, s / meta.height)
      this.setData({
        ready: true,
        frame: this._frame,
        iw: meta.width,
        ih: meta.height,
        disp: meta.path,
        k: this._fit,
        dx: 0,
        dy: 0
      }, () => {
        // 回调触发时视图已渲染，此时才能拿到 canvas 节点
        this.layout()
        this.ensureImage()
      })
    },

    /** 依当前缩放与位移算出图片左上角（保证覆盖取景框） */
    layout() {
      const f = this._frame
      if (!f) return
      const k = this.data.k
      const w = this._iw * k
      const h = this._ih * k
      this.setData({
        img: {
          left: f.x + (f.s - w) / 2 + this.data.dx,
        top: f.y + (f.s - h) / 2 + this.data.dy,
        w,
        h
      }
      })
    },

    /** 缩放收敛到 [fit, fit*MAX_ZOOM] */
    clampK(k) {
      const fit = this._fit || 1
      return Math.max(fit, Math.min(fit * MAX_ZOOM, k))
    },

    /** 位移收敛：图片显示尺寸减去取景框的一半即为可移动半径 */
    clamp(dx, dy, k) {
      const f = this._frame
      const kk = this.clampK(k)
      const mX = Math.max(0, (this._iw * kk - f.s) / 2)
      const mY = Math.max(0, (this._ih * kk - f.s) / 2)
      return {
        k: kk,
        dx: Math.max(-mX, Math.min(mX, dx)),
        dy: Math.max(-mY, Math.min(mY, dy))
      }
    },

    /* ---------------- 手势：拖动 / 捏合 / 手动 tap ---------------- */
    onTouchStart(e) {
      this.logEvt('touchstart', e)
      const t = e.touches && e.touches[0]
      this._s = {
        k: this.data.k,
        dx: this.data.dx,
        dy: this.data.dy,
        a: t,
        b: (e.touches && e.touches[1]) || null,
        /** 手动 tap 判定素材：起点坐标、时刻、命中目标的 data-act（confirm/cancel） */
        act: (e.target && e.target.dataset && e.target.dataset.act) || '',
        x: t ? t.clientX : 0,
        y: t ? t.clientY : 0,
        t: Date.now()
      }
    },

    onTouchMove(e) {
      const s = this._s
      if (!s || !e.touches.length) return
      const now = e.touches
      let next = { k: s.k, dx: s.dx, dy: s.dy }

      if (now.length >= 2 && s.b) {
        // 双指捏合：以手势起点为基准算缩放，并让双指中点下的图片像素保持不动
        const d0 = dist(s.a, s.b)
        const d1 = dist(now[0], now[1])
        const ka = this.clampK(d0 > 1 ? s.k * (d1 / d0) : s.k)
        const c0 = mid(s.a, s.b)
        const c1 = mid(now[0], now[1])
        const left0 = this._frame.x + (this._frame.s - this._iw * s.k) / 2 + s.dx
        const top0 = this._frame.y + (this._frame.s - this._ih * s.k) / 2 + s.dy
        const px = (c0.x - left0) / s.k
        const py = (c0.y - top0) / s.k
        next = { k: ka, dx: c1.x - this._frame.x - (this._frame.s - this._iw * ka) / 2 - px * ka, dy: c1.y - this._frame.y - (this._frame.s - this._ih * ka) / 2 - py * ka }
      } else if (now.length === 1 && !s.b) {
        const jx = now[0].clientX - s.a.clientX
        const jy = now[0].clientY - s.a.clientY
        // 点击抖动防护：鼠标点击常带 <1px 的 touchmove，此时不 setData ——
        // 避免点击瞬间重渲染，排除干扰 tap 合成的一切可能
        if (Math.abs(jx) < 1 && Math.abs(jy) < 1) return
        next = { k: s.k, dx: s.dx + jx, dy: s.dy + jy }
      } else {
        return
      }

      const c = this.clamp(next.dx, next.dy, next.k)
      this.setData({ k: c.k, dx: c.dx, dy: c.dy })
      this.layout()
    },

    onTouchEnd(e) {
      this.logEvt('touchend', e)
      /**
       * 手动 tap 判定（日志实锤的根因修复）：
       * 本环境下 touchstart/touchend 都正常到达按钮，但框架不合成 tap（catchtap 从不触发）。
       * 这里自己判：单指 + 起点 hit 中 data-act + 抬起位移 < 10px → 直接调对应处理。
       * catchtap 保留作兜底（tap 能合成的环境）；双触发由 busy / closing 状态天然去重：
       * confirm 第二次进 busy 已置真；cancel 第二次进 closing 已置真。
       */
      const s = this._s
      if (s && s.act && !s.b && !e.touches.length && e.changedTouches && e.changedTouches.length === 1) {
        const c = e.changedTouches[0]
        if (Math.hypot(c.clientX - s.x, c.clientY - s.y) < 10) {
          console.log('[avatar-cropper] 手动 tap →', s.act)
          this._s = null
          if (s.act === 'confirm') return this.onConfirm()
          if (s.act === 'cancel') return this.onCancel()
        }
      }
      if (!e.touches.length) { this._s = null; return }
      // 还有手指在屏上：以当前状态重设基准，避免抬指瞬间跳变（act 置空，防捏合收尾误判成点击）
      this._s = { k: this.data.k, dx: this.data.dx, dy: this.data.dy, a: e.touches[0], b: e.touches[1] || null, act: '' }
    },

    /**
     * 单独记录 touchcancel：点击被系统打断时会用 cancel 代替 end，
     * 而 cancel 不合成 tap —— 「点了没反应」的可疑通路，必须显式可见
     */
    onTouchCancel(e) {
      this.logEvt('⚠️ touchcancel', e)
      this._s = null
    },

    onCancel() {
      console.log('[avatar-cropper] onCancel 触发')
      if (this.data.busy) return
      this.beginClose(true)
    },

    /**
     * 确保「预载原图」已发起，且只发起一次
     * 用 deferred promise：onConfirm 可以先等，initCanvas 完成后再落结果
     */
    ensureImage() {
      if (!this._imgReady) {
        this._imgReady = new Promise((resolve) => { this._resolveImg = resolve })
        this.initCanvas()
      }
      return this._imgReady
    },

    /** 拿到 canvas 节点后预载原图（画布在 wx:if 里，关闭时置空，重开再查） */
    initCanvas() {
      if (this._canvas) { this.preload(); return }
      this.createSelectorQuery()
        .select('#cropCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const canvas = res && res[0] && res[0].node
          if (!canvas) {
            console.error('[avatar-cropper] canvas 节点不存在')
            this._finishImg(false)
            return
          }
          this._canvas = canvas
          this.preload()
        })
    },

    /**
     * 预载原图为可绘制 Image
     * ⚠️ 挂 this._img 是关键：只放局部变量会在异步解码期间被回收，
     *    onload/onerror 永不回调 —— 这就是「点使用没反应」的根因
     */
    preload() {
      const canvas = this._canvas
      if (!canvas || typeof canvas.createImage !== 'function') { this._finishImg(false); return }
      const img = canvas.createImage()
      this._img = img
      img.onload = () => this._finishImg(true)
      img.onerror = () => {
        console.error('[avatar-cropper] 原图加载失败', this._src)
        this._finishImg(false)
      }
      img.src = this._src || this.data.src
    },

    _finishImg(ok) {
      if (this._resolveImg) {
        this._resolveImg(ok)
        this._resolveImg = null
      }
    },

    /** 等图片就绪（带超时），返回是否已可用 */
    waitImage() {
      let timer
      const guard = new Promise((resolve) => {
        timer = setTimeout(() => {
          console.error('[avatar-cropper] 等图片就绪超时')
          resolve(false)
        }, IMG_TIMEOUT)
      })
      return Promise.race([this.ensureImage(), guard]).then((r) => {
        clearTimeout(timer)
        return r === true
      })
    },

    /**
     * 「使用」：导出取景框内的正方形图
     * 任何一步失败都回传原始图（fallback: true），保证「使用」永远有结果
     * 各节点带分步日志：真机排障时开 vConsole 就能看到卡在哪一步
     */
    async onConfirm() {
      console.log('[avatar-cropper] onConfirm 触发, busy =', this.data.busy)
      if (this.data.busy) return
      const f = this._frame
      // 兜底回落用的是规整后的本地路径：src 若为 http://tmp/... 落到页面也渲染不出来
      const raw = this._src || this.data.src
      if (!f || !this._iw) { U.toast('还没有可裁剪的图片'); return }

      this.setData({ busy: true })
      wx.showLoading({ title: '处理中…', mask: true })
      let path = ''
      try {
        const imgOk = await this.waitImage()
        console.log('[avatar-cropper] 原图就绪:', imgOk)
        if (imgOk) {
          path = await this.exportCrop(f)
          // 导出路径规整：DevTools 下 canvasToTempFilePath 返回 http://tmp/...（与 chooseMedia 同病，
          // 旧协议链接 compressImage/uploadFile 都用不了）→ 落盘换本地路径
          if (path) path = await this.ensureLocal(path)
        }
        console.log('[avatar-cropper] 导出结果:', path || '(空，走原图回落)')
      } catch (e) {
        console.error('[avatar-cropper] 裁剪异常', e)
      }
      wx.hideLoading()

      if (!path) U.toast('裁剪失败，已使用原图')
      this.setData({ busy: false })
      this.triggerEvent('confirm', { tempFilePath: path || raw, fallback: !path })
      this.beginClose(true)
    },

    /**
     * 把导出的 http://tmp/... 路径落盘换成本地路径（供编辑页压缩+上传）
     * ⚠️ 副本用唯一文件名（时间戳）：固定名 avatar_crop.jpg 覆盖后，编辑页表单里的
     *    <pet-avatar src> 对本地路径有缓存，二次裁剪会继续显示上一张（与 toLocal 同坑）。
     *    本文件所有权归页面（上传云存储），编辑页 onUnload 负责清理。
     * 任何一步失败返回原路径，由页面兜底
     */
    async ensureLocal(p) {
      if (!/^http:\/\//i.test(p || '')) return p
      try {
        const base = wx.env && wx.env.USER_DATA_PATH
        const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null
        if (!base || !fs) return p
        const target = `${base}/avatar_crop_${Date.now()}.jpg`
        const ok = await this.withTimeout(new Promise((resolve) => {
          try {
            fs.copyFile({ srcPath: p, destPath: target, success: () => resolve(true), fail: (e) => { console.warn('[avatar-cropper] 裁剪结果落盘失败', e); resolve(false) } })
          } catch (e) { resolve(false) }
        }), 5000, false)
        console.log('[avatar-cropper] 导出路径规整', ok ? target : '(失败，沿用原路径)')
        return ok ? target : p
      } catch (e) {
        console.warn('[avatar-cropper] ensureLocal 异常，沿用原路径', e)
        return p
      }
    },

    /** 画到离屏画布并导出正方形 jpg
     *  ⚠️ canvasToTempFilePath 在真机 2d 画布上存在「既不 success 也不 fail」不回调的情况
     *    （share-pop 已踩过并加超时，这里此前漏了 → await 永挂、busy 卡死、loading 不关，
     *     表现即「点使用没反应」）。导出内部自带超时，超时回落原图。 */
    exportCrop(f) {
      const canvas = this._canvas
      const img = this._img
      if (!canvas || !img) return Promise.resolve('')

      const dpr = U.getUI().dpr || 2
      const k = this.data.k
      const w = this._iw * k
      const h = this._ih * k
      canvas.width = Math.round(f.s * dpr)
      canvas.height = Math.round(f.s * dpr)
      const ctx = canvas.getContext('2d')
      // 画布坐标 = 屏幕坐标 − 取景框左上角；与预览同一套变换，所见即所得
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(dpr, dpr)
      ctx.translate((f.s - w) / 2 + this.data.dx, (f.s - h) / 2 + this.data.dy)
      ctx.scale(k, k)
      ctx.drawImage(img, 0, 0, this._iw, this._ih)

      console.log('[avatar-cropper] 画布绘制完成，请求导出', canvas.width, 'x', canvas.height)

      // 导出（自带超时：三种结局——success / fail / 超时不回调——日志各自可辨）
      const EXPORT_TIMEOUT = 5000
      const framed = () => new Promise((resolve) => {
        let settled = false
        const done = (p, tag) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          console.log('[avatar-cropper] 导出' + tag, p ? p.slice(0, 40) : '(空)')
          resolve(p)
        }
        const timer = setTimeout(() => {
          console.error('[avatar-cropper] canvasToTempFilePath ' + EXPORT_TIMEOUT + 'ms 未回调（真机已知坑，回落原图）')
          done('', '超时')
        }, EXPORT_TIMEOUT)
        wx.canvasToTempFilePath({
          canvas,
          destWidth: this.data.outSize,
          destHeight: this.data.outSize,
          fileType: 'jpg',
          quality: 0.9,
          success: (res) => done((res && res.tempFilePath) || '', '成功'),
          fail: (e) => { console.error('[avatar-cropper] 导出失败', e); done('', '失败') }
        }, this)
      })

      // 等一帧再导出：部分基础库下立即导出会拿到空白
      const nextFrame = typeof canvas.requestAnimationFrame === 'function'
        ? new Promise((resolve) => canvas.requestAnimationFrame(resolve))
        : new Promise((resolve) => setTimeout(resolve, 30))

      return nextFrame.then(framed).then((p) => p)
    },

    beginClose(notify) {
      if (!this.data.render || this.data.closing) return
      this.setData({ closing: true })
      clearTimeout(this._t)
      this._t = setTimeout(() => {
        // 画布随 wx:if 一起销毁，节点与图片引用一并释放，下次重开重新查询
        this._canvas = null
        this._img = null
        this._imgReady = null
        this._resolveImg = null
        this.setData({ render: false, closing: false, busy: false })
        this.triggerEvent('closed')
      }, 200)
      if (notify) this.triggerEvent('close')
    }
  }
})
