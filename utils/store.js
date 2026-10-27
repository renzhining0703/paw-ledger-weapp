/**
 * 全局状态与事件总线
 * - currentPetId：全局当前宠物，存 storage，冷启动读上次选择（PRD 7.1）
 * - pets：宠物列表缓存
 * - user：昵称/头像等可选设置
 * - 页面通过 store.on/off 订阅变更（如切换宠物后各页刷新）
 */
const config = require('./config')

const KEY_CURRENT_PET = 'tj_current_pet'
const KEY_USER = 'tj_user'

const state = {
  currentPetId: wx.getStorageSync(KEY_CURRENT_PET) || null,
  pets: [],
  user: wx.getStorageSync(KEY_USER) || null,
  subBalance: 0
}

const listeners = {}

/**
 * 数据变更版本号：任何一次写（含云端同步完成）都 +1。
 * 页面 onShow 时对比「自己上次刷新时看到的版本号」，不一致就强制回源，
 * 解决「在 A 页记了一笔，切到 B 页看到的还是缓存里的旧数据」。
 */
let dirtyVersion = 0
function markDirty() { dirtyVersion += 1 }
function dirtyVer() { return dirtyVersion }

/** 订阅事件（如 'petChanged' / 'petsChanged' / 'userChanged' / 'syncChanged'） */
function on(event, fn) {
  (listeners[event] = listeners[event] || []).push(fn)
  return () => off(event, fn)
}

function off(event, fn) {
  const arr = listeners[event] || []
  const i = arr.indexOf(fn)
  if (i > -1) arr.splice(i, 1)
}

function emit(event, payload) {
  ;(listeners[event] || []).slice().forEach((fn) => {
    try { fn(payload) } catch (e) { console.error('[store] listener error', event, e) }
  })
}

/* ---------------- 当前宠物 ---------------- */

function getCurrentPet() {
  if (!state.pets.length) return null
  return state.pets.find((p) => p._id === state.currentPetId) || state.pets[0]
}

/**
 * 当前（或指定）宠物是否共享
 *
 * ⚠️ 共享宠物读数据时必须**强制回源**：`dirtyVer` 只在「自己写入」时 +1，
 *    别人（成员/owner）新增了记录，本地版本号完全不变 → 走 60s 缓存就会一直看不到。
 *    这是共享场景下「别人发的图文我看不到」的直接原因。
 */
function isSharedPet(petId) {
  let p = null
  if (petId) p = (state.pets || []).filter((x) => x._id === petId)[0] || null
  if (!p) p = getCurrentPet()
  if (!p) return false
  return (p.memberCount || 1) > 1 || p.myRole === 'member'
}

function setCurrentPet(petId) {
  if (state.currentPetId === petId) return
  state.currentPetId = petId
  wx.setStorageSync(KEY_CURRENT_PET, petId)
  emit('petChanged', petId)
}

/* ---------------- 用户设置（可选头像昵称） ---------------- */

function getUser() {
  return state.user || { nickname: '', avatar: '' }
}

function setUser(partial) {
  state.user = { ...(state.user || {}), ...partial }
  wx.setStorageSync(KEY_USER, state.user)
  emit('userChanged', state.user)
  return state.user
}

module.exports = {
  state,
  on,
  off,
  emit,
  markDirty,
  dirtyVer,
  getCurrentPet,
  isSharedPet,
  setCurrentPet,
  getUser,
  setUser,
  MAX_PETS: config.MAX_PETS
}
