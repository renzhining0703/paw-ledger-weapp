/**
 * post-sheet：记一条图文（PRD v2.1 R1）
 *
 * 三个入口共用：
 *   时间线 FAB 选「图文」→ max=3, via='timeline'
 *   首页时间线锚点条相机    → max=3, via='timeline'
 *   相册页「＋ 传照片」     → max=9, via='album'（文案可空）
 *
 * 关键纪律：
 * 1. 图片不进离线写队列（图片必须先上传拿 fileID，断网做不到）
 * 2. 文案必过内容检测（P0 同步）；检测服务不可用 → 放行但 audit:'unchecked'，不假装通过
 * 3. 上传成功但落库失败 → 保留 fileID（this._uploaded），避免重复上传与孤儿文件
 * 4. 关闭/成功/卸载三处都要清落盘副本，防 USER_DATA_PATH 累积
 * 5. 断网不丢：选图 + 文案 + 日期存 storage 草稿，下次打开同宠物时恢复
 */
const db = require('../../utils/db')
const store = require('../../utils/store')
const track = require('../../utils/track')
const U = require('../../utils/util')
const media = require('../../utils/media')

const DRAFT_KEY = 'tj_post_draft'

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  properties: {
    show: { type: Boolean, value: false },
    petId: { type: String, value: '' },
    petName: { type: String, value: '' },
    /** 时间线入口 3 张 / 相册入口 9 张 */
    max: { type: Number, value: 3 },
    /** 仅用于埋点，不落库：'timeline' | 'album' */
    via: { type: String, value: 'timeline' }
  },
  data: {
    content: '',
    count: 0,
    picks: [],          // [{ path, w, h }]
    date: '',
    today: '',
    visibility: 'all',  // 'all' 默认 | 'private'
    saving: false,
    savingText: '发布',
    restored: false,
    subTitle: ''
  },
  observers: {
    // 只在打开时重置（observer 内禁止回传事件，防事件回环）
    show(v) {
      if (!v) return
      this.reset()
    }
  },
  lifetimes: {
    detached() {
      this.cleanLocals(this.data.picks)
    }
  },
  methods: {
    /* ---------- 初始化 / 草稿 ---------- */

    currentPetId() {
      return this.data.petId || (store.getCurrentPet() || {})._id || ''
    },

    reset() {
      const today = U.todayStr()
      const d = this.loadDraft()
      const petName = this.data.petName || (store.getCurrentPet() || {}).name || '它'
      this._uploaded = null
      this.setData({
        content: d ? d.content : '',
        count: d && d.content ? d.content.length : 0,
        picks: d ? d.picks : [],
        date: (d && d.date) || today,
        today,
        visibility: (d && d.visibility) || 'all',
        saving: false,
        savingText: '发布',
        restored: !!d,
        subTitle: `记给 ${petName} · 最多 ${this.data.max} 张`
      })
    },

    loadDraft() {
      try {
        const d = wx.getStorageSync(DRAFT_KEY)
        if (!d || !d.petId) return null
        if (d.petId !== this.currentPetId()) return null
        const hasText = !!(d.content || '').trim()
        const hasPic = !!(d.picks || []).length
        if (!hasText && !hasPic) return null
        return d
      } catch (e) {
        return null
      }
    },

    saveDraft() {
      const content = String(this.data.content || '').trim()
      const picks = this.data.picks || []
      if (!content && !picks.length) { this.clearDraft(); return }
      try {
        wx.setStorageSync(DRAFT_KEY, {
          petId: this.currentPetId(),
          content: this.data.content,
          picks,
          date: this.data.date,
          visibility: this.data.visibility,
          at: Date.now()
        })
      } catch (e) { /* 忽略：草稿是加分项，存不下不影响发布 */ }
    },

    clearDraft() {
      try { wx.removeStorageSync(DRAFT_KEY) } catch (e) { /* 忽略 */ }
    },

    cleanLocals(picks) {
      const list = (picks || [])
        .map((p) => p && (p.localPath || p.path))
        .filter(Boolean)
      if (list.length) media.unlink(list)
    },

    /* ---------- 表单 ---------- */

    onInput(e) {
      const v = e.detail.value || ''
      this.setData({ content: v, count: v.length })
    },

    onBlur() {
      this.saveDraft()
    },

    async onAdd() {
      if (this._picking) return
      const left = this.data.max - this.data.picks.length
      if (left <= 0) { U.toast(`最多 ${this.data.max} 张`); return }
      this._picking = true
      try {
        const list = await media.pickImages(left)
        if (!list.length) return
        const add = list.slice(0, left).map((x) => ({ path: x.path, w: x.w, h: x.h }))
        if (list.length > left) U.toast(`最多 ${this.data.max} 张，已选前 ${left} 张`)
        this.setData({ picks: this.data.picks.concat(add) })
        this.saveDraft()
      } catch (e) {
        console.error('[post-sheet] 选图失败', e)
        if (e && e.code === 'privacy') {
          wx.showModal({
            title: '选不了照片',
            content: '小程序后台还没声明「选中的照片或视频信息」权限，配好后才能选图。',
            showCancel: false,
            confirmText: '知道了'
          })
          return
        }
        U.toastErr(e, '选择图片失败')
      } finally {
        this._picking = false
      }
    },

    onRemove(e) {
      const i = Number(e.currentTarget.dataset.i)
      const picks = this.data.picks.slice()
      const gone = picks.splice(i, 1)[0]
      this.setData({ picks })
      if (gone) media.unlink(gone.path)
      this.saveDraft()
    },

    onPreview(e) {
      const i = Number(e.currentTarget.dataset.i)
      const urls = this.data.picks.map((p) => p.path).filter(Boolean)
      if (!urls.length) return
      wx.previewImage({ urls, current: urls[i] || urls[0] })
    },

    onDateChange(e) {
      this.setData({ date: e.detail.value })
      this.saveDraft()
    },

    onVis(e) {
      const v = e.currentTarget.dataset.v === 'private' ? 'private' : 'all'
      this.setData({ visibility: v })
      this.saveDraft()
    },

    /** 用户主动关闭（遮罩 / ✕）→ 通知父级把 show 置 false */
    onClose() {
      if (this.data.saving) { U.toast('正在发布，稍等一下'); return }
      this.saveDraft()
      this.triggerEvent('close')
    },

    /* ---------- 发布 ---------- */

    async onPublish() {
      if (this.data.saving) return
      const petId = this.currentPetId()
      if (!petId) { U.toast('先创建宠物档案，才能发图文'); return }
      const content = String(this.data.content || '').trim()
      const picks = this.data.picks || []
      if (!content && !picks.length) { U.toast('写点什么，或者选一张照片'); return }

      this.setData({ saving: true, savingText: '发布中…' })
      try {
        // 1) 文案内容安全（P0 同步拦截，红线第 2 条：不许静默放过）
        let audit = 'ok'
        if (content) {
          this.setData({ savingText: '检查文字…' })
          let chk = null
          try {
            chk = await db.checkText(content)
          } catch (e) {
            // 检测链路本身挂了：不阻塞发布，但把这条标记成未检测（后续可抽查）
            console.error('[post-sheet] 内容检测调用失败', e)
            chk = { pass: true, unchecked: true }
          }
          if (chk && chk.pass === false) {
            track.track('upload_failed', { stage: 'seccheck', petId })
            this.setData({ saving: false, savingText: '发布' })
            wx.showModal({
              title: '这段文字没通过检查',
              content: '文字可能包含不合适的内容，改一下再试试。',
              showCancel: false,
              confirmText: '去修改'
            })
            return
          }
          if (chk && chk.unchecked) audit = 'unchecked'
        }

        // 2) 双档压缩 + 上传（thumb 用于列表，full 用于全屏预览）
        let images = this._uploaded || []
        if (picks.length) {
          images = await media.buildPostImages(petId, picks, (i, total, stage) => {
            this.setData({
              savingText: (stage === 'compress' ? '处理图片 ' : '上传图片 ') + (i + 1) + '/' + total
            })
          })
          // 上传成功但下一步落库失败时要复用，别再传一次（省流量、防孤儿文件）
          this._uploaded = images
        }

        // 3) 落库（云端在这里做**权威**检测：文案 + 图片同步拦）
        this.setData({ savingText: '检查内容…' })
        const tSec = Date.now()
        const r = await db.addPost(petId, {
          content,
          images: images.map((im) => ({ fileID: im.fileID, thumbID: im.thumbID, w: im.w, h: im.h })),
          visibility: this.data.visibility,
          date: this.data.date,
          audit
        })

        // ⚠️ 埋点在前端打：云函数里直接写 events 会绕过 track 云函数的白名单校验
        //    result='review'(pending) 占比长期偏高 = 超时预算太紧或配额有问题，要调
        track.track('sec_checked', {
          target: content && images.length ? 'both' : (images.length ? 'image' : 'text'),
          result: r.audit === 'pending' ? 'review' : 'pass',
          latencyMs: Date.now() - tSec
        })

        track.track('post_added', {
          petId,
          imgCount: images.length,
          hasText: !!content,
          via: this.data.via,
          shared: ((store.getCurrentPet() || {}).memberCount || 1) > 1,
          // ⚠️ 必带：这是「私密占比」长期监控指标的唯一数据源（PRD 6.8）
          visibility: this.data.visibility,
          // 这批图的平均体积（KB）：CDN 流量占资源点大头，用它判断「压缩档位是否真的生效」
          // （低版本基础库会忽略 compressedWidth/Height，体积会突然翻好几倍）
          avgKB: images.length
            ? Math.round(images.reduce((s, im) => s + (((im.bytes || {}).thumb || 0) + ((im.bytes || {}).full || 0)), 0) / images.length / 1024)
            : 0
        })

        this.clearDraft()
        this._uploaded = null
        this.cleanLocals(picks)
        this.setData({ saving: false, savingText: '发布', picks: [], content: '', count: 0 })
        U.toast('记好了')
        this.triggerEvent('saved', {
          _id: r._id,
          date: this.data.date,
          visibility: this.data.visibility,
          imgCount: images.length
        })
      } catch (e) {
        console.error('[post-sheet] 发布失败', e)
        const code = e && e.errCode
        const res = (e && e.result) || {}
        this.setData({ saving: false, savingText: '发布' })

        // ① 封禁：必须翻成人话，别弹「操作失败」；也不存草稿（存了也发不出去）
        if (code === 403 && res.banned) {
          U.toast('账号已被限制发布，如有疑问请联系我们')
          return
        }
        // ② 安全拦截：云端已经把图删了 → 本地的上传产物必须一起作废，
        //    否则下次点发布会拿一批不存在的 fileID 再走一遍
        if (code === 107) {
          track.track('upload_failed', { stage: 'seccheck', petId })
          this._uploaded = null
          wx.showModal({
            title: '这条内容没通过检查',
            content: res.target === 'text'
              ? '文字可能包含不合适的内容，改一下再试试。'
              : '这张图片可能包含不合适的内容，换一张试试。',
            showCancel: false,
            confirmText: '去修改'
          })
          return
        }
        // ③ 限流：文案直接用云端给的；不存草稿（明天再发才有意义）
        if (code === 105 || code === 106) {
          U.toast((e && e.message) || '今天记录得够多啦，明天再来')
          return
        }

        track.track('upload_failed', {
          stage: this._uploaded ? 'db' : 'upload',
          petId
        })
        this.saveDraft()
        U.toastErr(e, '发布失败，已存草稿，可再试一次')
      }
    }
  }
})
