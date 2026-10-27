/**
 * 宠物档案编辑页：新增/编辑同一页（PRD 5.8）
 * 物种九选宫格（决定占位头像/体重单位/是否预置周期）、体重单位分段、
 * 生日与到家日独立可选、初始体重（档案基准值，不写体重流水）、血统；
 * 编辑态底部红色「删除这只宠物」
 *
 * ⚠️ 体重职责边界：本页只维护「初始体重」这一个基准值（写 pets.weight）。
 *    日常每次称重统一走首页「记体重」→ weights 集合，时间线/趋势只认 weights。
 *    所以这里**不能**再调 recordWeightHistory（那会让「改档案」变成「又称了一次」）。
 */
const config = require('../../../utils/config')
const store = require('../../../utils/store')
const db = require('../../../utils/db')
const U = require('../../../utils/util')
const track = require('../../../utils/track')
const inviteShare = require('../../../utils/invite-share')
const media = require('../../../utils/media')

Page({
  data: {
    editing: false,
    saving: false,
    speciesList: config.SPECIES.map((s) => ({ key: s.key, name: s.name, emoji: s.emoji || '🐾' })),
    /** 是否绝育的选项：单一数据源是 config.NEUTER_OPTIONS，页面不写死枚举 */
    neuterOptions: config.NEUTER_OPTIONS,
    avatar: '',
    /** 头像占位是否用 🐾（新建且尚未选物种；对齐设计稿新建态） */
    avatarPaw: true,
    name: '',
    species: 'cat',
    unit: 'kg',
    breed: '',
    gender: '未知',
    /** 是否绝育：默认「未知」（未填写），取值来自 config.NEUTER_OPTIONS */
    neutered: '未知',
    birthday: '',
    adoptDay: '',
    /** 初始体重：档案基准值（字符串，便于输入框双向绑定）；不产生 weights 流水 */
    weight: '',
    pedigree: '',
    today: '',
    minDate: '1990-01-01',
    breedOptions: [],
    /** 裁剪层 */
    showCropper: false,
    cropSrc: '',
    /** 新头像已放入表单但未保存（头像卡右上角「未保存」角标） */
    avatarDirty: false,
    /** PRD 5.4：仅 owner 可编辑档案，member 只读 */
    isOwnerView: true
  },

  onLoad(query) {
    this.setData({ today: U.todayStr() })
    if (query.id) {
      this.loadPet(query.id)
    } else {
      // 新建：先同步一次列表，保证数量校验与首页切换弹框数据准确
      db.listPets().then((pets) => { store.state.pets = pets }).catch(() => {})
      this.buildSnap()
    }
  },

  async loadPet(id) {
    try {
      await getApp().ready(2000)
      const pets = await db.listPets()
      const pet = pets.find((p) => p._id === id)
      if (!pet) { U.toast('宠物不存在'); return }
      this._pet = pet
      // 初始体重：统一走 initWeightOf 兜底（旧档案字段是 initWeight；空串/无效值 → null）
      const initWeight = U.initWeightOf(pet)
      this.setData({
        editing: true,
        // PRD 5.4：member 打开档案页为只读（myRole 由 listPets 云函数返回）
        isOwnerView: pet.myRole !== 'member',
        avatarPaw: false,
        avatar: pet.avatar || '',
        name: pet.name || '',
        species: pet.species || 'cat',
        unit: pet.weightUnit || 'kg',
        breed: pet.breed || '',
        gender: pet.gender || '未知',
        // 是否绝育：历史档案没有这个字段 → 回落「未知」
        neutered: pet.neutered || '未知',
        birthday: pet.birthday || '',
        adoptDay: pet.adoptDay || '',
        // 保存后统一写 weight（旧档案只有 initWeight 时读取已被上面兜底）
        weight: initWeight !== null ? String(initWeight) : '',
        pedigree: pet.pedigree || ''
      })
      this.buildSnap()
    } catch (e) {
      console.error(e)
      U.toast('加载失败')
    }
  },

  /* ================= 未保存保护 ================= */

  /**
   * 表单快照：离开拦截的判定基准（回填完成 / 新建进入时各打一次）
   * ⚠️ setData 后 this.data 已同步更新，渲染虽异步，但快照只读数据不依赖渲染
   */
  buildSnap() {
    const d = this.data
    this._snap = {
      name: d.name, species: d.species, unit: d.unit, breed: d.breed,
      gender: d.gender, neutered: d.neutered, birthday: d.birthday, adoptDay: d.adoptDay,
      weight: d.weight, pedigree: d.pedigree
    }
  },

  /** 是否有未保存修改：新头像（还没点保存，丢了要重裁剪一遍，代价最高）优先判定 */
  isDirty() {
    if (this._avatarLocal) return true
    if (!this._snap) return false
    const d = this.data
    return Object.keys(this._snap).some((k) => d[k] !== this._snap[k])
  },

  /** 字段每次变更后调用：dirty 状态翻转时启用/关闭「返回前系统询问」 */
  updateUnloadGuard() {
    // member 只读：改了也存不了，不能启用离开拦截（否则改完走不掉、又保存不了，死锁）
    if (this.data.editing && !this.data.isOwnerView) return
    const dirty = this.isDirty()
    if (dirty === this._dirty) return
    this._dirty = dirty
    if (dirty && typeof wx.enableAlertBeforeUnload === 'function') {
      wx.enableAlertBeforeUnload({
        message: '有未保存的修改（含新头像），离开将丢失',
        success: () => {},
        fail: () => { /* 低版本基础库无此 API：静默降级，无拦截 */ }
      })
    } else if (!dirty && typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload({ success: () => {}, fail: () => {} })
    }
  },

  /** 保存成功 / 删除后退出前调用：解除离开拦截 */
  clearDirty() {
    this._dirty = false
    this._avatarLocal = ''
    this.setData({ avatarDirty: false })
    if (typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload({ success: () => {}, fail: () => {} })
    }
  },

  noop() {},

  /**
   * 更换头像：先过隐私协议授权，再进裁剪层
   * ⚠️ 未声明隐私保护指引时直接调 chooseMedia 会 errno 112
   *    （api scope is not declared in the privacy agreement）
   */
  /** PRD 5.1：档案页直接发起邀请（button open-type=share 触发；标题/图片对齐设计稿分享卡片） */
  async onShareAppMessage() {
    const pet = this._pet
    if (!pet || !pet._id) return { title: '它的时光' }
    return inviteShare.build(this, pet, 'card')
  },

  onChooseAvatar() {
    // member 只读：头像与档案字段一样仅 owner 可改；换了也没有保存入口，只会白裁剪一遍
    if (this.data.editing && !this.data.isOwnerView) {
      U.toast('仅创建者可修改档案')
      return
    }
    if (typeof wx.requirePrivacyAuthorize !== 'function') { this.pickImage(); return }
    wx.requirePrivacyAuthorize({
      success: () => this.pickImage(),
      fail: (e) => {
        console.error('[edit] 隐私授权未通过', e)
        U.toast(e && e.errno === 112
          ? '小程序后台未配置隐私保护指引（需声明相册权限）'
          : '需要同意隐私协议才能选图')
      }
    })
  },

  /**
   * 相册选图 → 进裁剪层（拖动/缩放定位置）
   * 确认后的临时路径写入 _avatarLocal，保存时再压缩并上传云存储
   */
  pickImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      success: (r) => {
        if (r.tempFiles && r.tempFiles[0]) {
          // 重新选图：丢掉上一张待上传的本地副本（连文件一起删，防 USER_DATA_PATH 累积）
          this.cleanAvatarLocal()
          this.setData({ cropSrc: r.tempFiles[0].tempFilePath, showCropper: true })
        }
      },
      fail: (e) => {
        // 以前没有 fail：授权被拒 / 取消 / 环境不支持时就是「点了没反应」
        console.error('[edit] chooseMedia 失败', e)
        if (e && e.errMsg && /cancel/i.test(e.errMsg)) return
        U.toast('选图失败，请重试')
      }
    })
  },

  /** 裁剪确认：回传的即取景框内的正方形图（注意：只是放进表单，要点「保存」才上传落库） */
  onCropConfirm(e) {
    const p = e.detail.tempFilePath
    if (!p) return
    this._avatarLocal = p
    this.setData({ avatar: p, showCropper: false, avatarDirty: true })
    this.updateUnloadGuard()
  },

  onCropCancel() { this.setData({ showCropper: false }) },

  onName(e) { this.setData({ name: e.detail.value }); this.updateUnloadGuard() },
  onSpecies(e) {
    const key = e.currentTarget.dataset.k
    const sp = config.SPECIES.find((s) => s.key === key)
    // 选了物种后头像占位从 🐾 换成该物种 emoji（已有真头像时不受影响）
    this.setData({ species: key, unit: sp ? sp.unit : this.data.unit, avatarPaw: false })
    this.updateUnloadGuard()
  },
  onUnit(e) { this.setData({ unit: e.currentTarget.dataset.u }); this.updateUnloadGuard() },
  onBreed(e) { this.setData({ breed: e.detail.value }); this.updateUnloadGuard() },
  onGender(e) { this.setData({ gender: e.currentTarget.dataset.g }); this.updateUnloadGuard() },
  onNeutered(e) {
    const v = e.currentTarget.dataset.n
    // 只接受枚举内的值：防止脏数据进表单（wxml 用 for 渲染，理论上不会传野值）
    if (config.NEUTER_OPTIONS.indexOf(v) === -1) return
    this.setData({ neutered: v }); this.updateUnloadGuard()
  },
  onBirthday(e) { this.setData({ birthday: e.detail.value }); this.updateUnloadGuard() },
  onAdoptDay(e) { this.setData({ adoptDay: e.detail.value }); this.updateUnloadGuard() },
  onWeight(e) { this.setData({ weight: e.detail.value }); this.updateUnloadGuard() },
  onPedigree(e) { this.setData({ pedigree: e.detail.value }); this.updateUnloadGuard() },

  validate() {
    const d = this.data
    if (!d.name.trim()) return '给TA取个名字吧'
    if (d.name.trim().length > 12) return '昵称最多 12 字'
    if (d.birthday && d.birthday > d.today) return '生日不能晚于今天'
    if (d.adoptDay && d.adoptDay > d.today) return '到家日不能晚于今天'
    if (d.weight) {
      const v = parseFloat(d.weight)
      if (isNaN(v) || v < 0.1 || v > 100) return '体重范围 0.1–100'
    }
    return ''
  },

  async onSave() {
    if (this.data.saving) return
    // PRD 5.4：member 无权编辑档案
    if (this.data.editing && !this.data.isOwnerView) {
      U.toast('仅创建者可修改档案')
      return
    }
    const err = this.validate()
    if (err) { U.toast(err); return }
    const d = this.data
    this.setData({ saving: true })
    const payload = {
      name: d.name.trim(),
      species: d.species,
      weightUnit: d.unit,
      breed: d.breed.trim(),
      gender: d.gender,
      neutered: d.neutered,
      birthday: d.birthday || '',
      adoptDay: d.adoptDay || '',
      weight: d.weight ? Math.round(parseFloat(d.weight) * 10) / 10 : '',
      pedigree: d.pedigree.trim()
    }
    try {
      // 头像压缩上传云存储
      // ⚠️ 上传失败不再静默：头像没传上去要让用户知道，否则「已保存」但全站头像丢失（已踩）
      let avatarFailed = false
      if (this._avatarLocal) {
        try {
          console.log('[edit] 头像待上传:', String(this._avatarLocal).slice(0, 60))
          const cmp = await new Promise((resolve) => {
            wx.compressImage({ src: this._avatarLocal, quality: 50, success: (r) => resolve(r.tempFilePath), fail: (e) => { console.warn('[edit] compressImage 失败，用原图上传', e); resolve(this._avatarLocal) } })
          })
          const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e4)}`
          const up = await wx.cloud.uploadFile({
            cloudPath: `pet/${stamp}.jpg`,
            filePath: cmp
          })
          payload.avatar = up.fileID
          console.log('[edit] 头像已上传, fileID =', up.fileID)
          // 顺带生成小头像：切换弹框 / 相册顶行 / 记账宠物条这些 88rpx 以下的位置都用它，
          // 列表一次 5 只宠物能省掉 1MB+ 下行。失败无所谓，回落主头像（见 media.buildAvatarSmall）
          try {
            const small = await media.buildAvatarSmall(`pet/${stamp}_s.jpg`, cmp)
            if (small) payload.avatarSmall = small
          } catch (e) {
            console.warn('[edit] 小头像生成失败，忽略', e)
          }
        } catch (e) {
          console.error('[edit] 头像上传失败', e)
          avatarFailed = true
        }
      }

      const startTs = this._openTs || Date.now()
      if (d.editing) {
        await db.updatePet(this._pet._id, payload)
        // 体重流水不由本页产生（见文件头「体重职责边界」）
        // 用云端真值刷新列表（含 updatedAt / 头像 fileID），再通知首页
        store.state.pets = await db.listPets(true).catch(() => store.state.pets)
        store.emit('petChanged', this._pet._id)
      } else {
        if (store.state.pets.length >= config.MAX_PETS) {
          U.toast(`最多添加 ${config.MAX_PETS} 只宠物`)
          this.setData({ saving: false })
          return
        }
        const r = await db.addPet(payload)
        payload._id = r._id
        const isFirstPet = store.state.pets.length === 0
        // 重新拉取，保证切换弹框 / 首页拿到的是完整文档（createdAt 排序、头像 fileID 等）
        store.state.pets = await db.listPets(true).catch(() => store.state.pets.concat([{ ...payload }]))
        store.setCurrentPet(r._id)
        track.track('pet_created', {
          species: d.species,
          isFirstPet,
          durationMs: Date.now() - startTs
        })
        // 新建后直接通知首页刷新（不依赖 onShow 时序，避免返回时页面还是旧状态）
        store.emit('petChanged', r._id)
      }
      this.setData({ saving: false })
      // 上传成功才删裁剪导出的本地副本；失败保留 _avatarLocal 供用户重按保存重试
      if (!avatarFailed) this.cleanAvatarLocal()
      // 保存成功才解除离开拦截（在 toast/navigateBack 之前，时序才安全）
      this.clearDirty()
      // 头像失败要明示：静默吞掉会让用户以为换头成功了，实际全站还是旧头像（已踩）
      U.toast(avatarFailed ? '档案已保存，但头像上传失败' : (d.editing ? '已保存' : '建档成功'))
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      console.error('保存档案失败', e)
      this.setData({ saving: false })
      U.toast('保存失败，请重试')
    }
  },

  /** 删除裁剪导出的本地副本（avatar_crop_*.jpg 所有权归本页）+ 清引用 */
  cleanAvatarLocal() {
    const p = this._avatarLocal
    this._avatarLocal = ''
    if (!p || !wx.env || !wx.env.USER_DATA_PATH) return
    if (String(p).indexOf(wx.env.USER_DATA_PATH) !== 0) return
    try {
      wx.getFileSystemManager().unlink({ filePath: p, fail: () => {} })
    } catch (e) { /* 环境不支持则忽略 */ }
  },

  onUnload() {
    // 未保存退出：导出副本不再被任何方引用（保存成功路径已另行删除），这里兜底防累积
    this.cleanAvatarLocal()
  },

  onDelete() {
    const pet = this._pet
    if (!pet) return
    U.confirmDelete(`删除 ${pet.name}？其名下全部记录将一并删除，无法恢复`, async () => {
      try {
        wx.showLoading({ title: '删除中…' })
        await db.removePet(pet._id)
        wx.hideLoading()
        track.track('pet_deleted', {})
        const rest = store.state.pets.filter((p) => p._id !== pet._id)
        store.state.pets = rest
        if (store.state.currentPetId === pet._id) {
          store.setCurrentPet(null)
          if (rest.length) store.setCurrentPet(rest[0]._id)
        }
        // 删除是用户明确意图：退出前解除「未保存修改」拦截，否则返回手势会弹确认
        this.clearDirty()
        wx.navigateBack()
      } catch (e) {
        wx.hideLoading()
        console.error(e)
        U.toast('删除失败，请重试')
      }
    })
  }
})
