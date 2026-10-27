/**
 * 图片管线：选图 → 路径规整 → 双档压缩 → 上传云存储（PRD v2.1 6.4 / 6.5）
 *
 * 为什么必须双档：云开发的云存储**没有图片处理参数**（不像 OSS/COS 数据万象），
 * 列表没法「自动生成缩略图」，只能单独存一份 thumb 文件。若列表直接加载 250KB 原图，
 * CDN 下行流量会先于存储爆掉（100 用户 ≈ 12GB/月）。所以：
 *   列表 / 时间线 / 相册网格 → thumb（长边 480 / q60，约 30-50KB）
 *   wx.previewImage 全屏     → full （长边 1080 / q75，约 200-300KB）
 *
 * 踩坑沿用（见 components/avatar-cropper）：
 * 1. DevTools 的临时文件是 `http://tmp/...`，compressImage / uploadFile / <image> 全用不了
 *    → 交给「压缩 / 上传 / 展示」前必须先落盘规整成 wxfile:// 本地路径
 * 2. 落盘副本必须唯一命名（时间戳）：小程序按路径缓存本地图片，固定名会一直显示上一张
 * 3. 所有原生 API 都要超时兜底：真机上存在既不 success 也不 fail 的情况，
 *    await 会永久挂死，用户看到的就是「点了没反应」
 * 4. 压缩属于「可选优化」：失败要降级沿用原图，不能当成致命错误（否则功能从「弱一点」变「不能用」）
 */
const U = require('./util')

const THUMB_LONG = 480
const THUMB_Q = 60
const FULL_LONG = 1080
const FULL_Q = 75

const MAX_TIMELINE = 3
const MAX_ALBUM = 9

/**
 * 头像小图档（上传宠物头像时顺带生成一份）
 *
 * 为什么必须有：小头像出现的地方又多又散 —— 切换宠物弹框 88rpx、相册顶行 44rpx、
 * 记账宠物条 40rpx、成员列表 80rpx、分享长图里的头像…… 这些位置若直接加载几百 KB 的原头像，
 * 列表一次 5 只宠物就是 1MB+，旧机型解码大图还会掉帧。云开发没有图片处理参数，只能存两份。
 *
 * 200px 的取值：最大用到 88rpx（44pt），3x 屏需要 132px；留出余量到 200px，
 * 单张约 8–15KB，成本可以忽略。
 */
const AVATAR_SMALL_LONG = 200
const AVATAR_SMALL_Q = 70

/**
 * 体积上限（超了就自动降一档 quality 再压）
 *
 * 为什么需要这道闸：`compressedWidth/compressedHeight` 要基础库 2.26.0+，
 * 低版本会**静默忽略这两个参数**，只按 quality 压 → thumb 变成「原分辨率 + q60」，
 * 一张能到 300KB+（列表按 30 张算就是 9MB 一次浏览，CDN 直接翻 7 倍）。
 * 不报错、不失败，只能靠压完量体积发现。
 *
 * ⚠️ thumb 的上限定在 **90KB 而不是 150KB**，是为了给 `security.imgSecCheck` 让路：
 *    该接口文档写「≤1MB」，但实战中 Buffer 超过 100KB 就常报「图片太大」。
 *    超了不会拒绝发布（fail-open 会放行成 pending），但那条图文就**永远检测不了**，
 *    只能等巡检——而巡检拿到的还是同一张超大小的图，照样失败。
 *    90KB 是「能不能检测」的前提，不是画质取舍（长边只有 480，90KB 画质绰绰有余）。
 */
const THUMB_MAX_BYTES = 90 * 1024
const FULL_MAX_BYTES = 420 * 1024

function isHttp(p) {
  return /^https?:\/\//i.test(String(p || ''))
}

function uniqName(prefix, ext) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext || 'jpg'}`
}

/** 落盘规整：`http://tmp/xxx` → USER_DATA_PATH 下的唯一本地文件；任何失败都沿用原路径 */
function toLocal(src) {
  const s = String(src || '')
  if (!s || !isHttp(s)) return Promise.resolve(s)
  const base = wx.env && wx.env.USER_DATA_PATH
  const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null
  if (!base || !fs) return Promise.resolve(s)
  const target = `${base}/${uniqName('post_src')}`

  const copy = () => U.withTimeout(new Promise((resolve) => {
    try {
      fs.copyFile({
        srcPath: s,
        destPath: target,
        success: () => resolve(target),
        fail: () => {
          try {
            fs.saveFile({
              tempFilePath: s,
              filePath: target,
              success: () => resolve(target),
              fail: () => resolve(s)
            })
          } catch (e) { resolve(s) }
        }
      })
    } catch (e) { resolve(s) }
  }), 8000, '图片落盘').catch(() => s)

  return copy()
}

/** 清掉落盘副本（发布成功 / 关闭弹层 / 页面卸载三处都要调，防 USER_DATA_PATH 累积） */
function unlink(list) {
  const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null
  if (!fs) return
  ;(Array.isArray(list) ? list : [list]).forEach((p) => {
    const s = String(p || '')
    if (!s || isHttp(s)) return
    try { fs.unlink({ filePath: s, success: () => {}, fail: () => {} }) } catch (e) { /* 忽略 */ }
  })
}

/** 读原图尺寸（读不到返回 {0,0}，不阻断流程） */
function getInfo(src) {
  return U.withTimeout(new Promise((resolve) => {
    try {
      wx.getImageInfo({
        src,
        success: (r) => resolve({ w: r.width || 0, h: r.height || 0 }),
        fail: () => resolve({ w: 0, h: 0 })
      })
    } catch (e) { resolve({ w: 0, h: 0 }) }
  }), 6000, '读取图片信息').catch(() => ({ w: 0, h: 0 }))
}

/**
 * 选图（含隐私授权前置）
 *
 * ⚠️ mp 后台《用户隐私保护指引》必须声明「选中的照片或视频信息」，
 *    否则 chooseMedia 直接 errno 112（api scope is not declared in the privacy agreement），
 *    平台级限制，改代码无解 —— 但必须把原因说出来，不能表现成「点了没反应」。
 *
 * @returns {Promise<Array<{path,w,h,size}>>} 用户取消 → 空数组（不是错误）
 */
function pickImages(count) {
  const max = Math.max(1, Math.min(MAX_ALBUM, count || MAX_ALBUM))
  return new Promise((resolve, reject) => {
    const doPick = () => {
      try {
        wx.chooseMedia({
          count: max,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
          sizeType: ['compressed'],
          success: (r) => {
            const list = (r.tempFiles || []).map((f) => ({
              path: f.tempFilePath,
              w: f.width || 0,
              h: f.height || 0,
              size: f.size || 0
            }))
            resolve(list)
          },
          fail: (e) => {
            const msg = String((e && e.errMsg) || '')
            if (/cancel/i.test(msg)) { resolve([]); return }
            console.error('[media] chooseMedia 失败', msg)
            const err = new Error(msg || '选择图片失败')
            err.code = /privacy|scope|112/i.test(msg) ? 'privacy' : 'album'
            reject(err)
          }
        })
      } catch (e) {
        const err = new Error('当前环境不支持选图')
        err.code = 'unsupport'
        reject(err)
      }
    }

    if (typeof wx.requirePrivacyAuthorize !== 'function') { doPick(); return }
    wx.requirePrivacyAuthorize({
      success: doPick,
      fail: (e) => {
        console.error('[media] 隐私授权未通过', e)
        const err = new Error(e && e.errno === 112 ? '后台未声明相册权限' : '需要同意隐私协议才能选图')
        err.code = 'privacy'
        reject(err)
      }
    })
  })
}

/** 单档压缩：失败降级沿用原图 */
function compressOne(localPath, w, h, longSide, quality) {
  const src = String(localPath || '')
  if (!src) return Promise.resolve('')
  // 按长边等比缩放：同时给 compressedWidth/Height 才不会变形
  let cw = 0
  let ch = 0
  if (w > 0 && h > 0) {
    const scale = Math.min(1, longSide / Math.max(w, h))
    cw = Math.max(1, Math.round(w * scale))
    ch = Math.max(1, Math.round(h * scale))
    // 已经比目标小：不用压（再压一次只会掉画质）
    if (scale >= 1) return Promise.resolve(src)
  }
  return U.withTimeout(new Promise((resolve) => {
    try {
      wx.compressImage({
        src,
        quality,
        compressedWidth: cw,
        compressedHeight: ch,
        success: (r) => resolve((r && r.tempFilePath) || src),
        fail: (e) => {
          console.warn('[media] compressImage 失败，沿用原图', e)
          resolve(src)
        }
      })
    } catch (e) { resolve(src) }
  }), 20000, '图片压缩').catch(() => src)
}

/** 上传单张，返回 fileID（失败抛错，由调用方决定降级策略） */
async function uploadOne(filePath, cloudPath) {
  const r = await U.withTimeout(
    wx.cloud.uploadFile({ cloudPath, filePath }),
    40000,
    '图片上传'
  )
  const id = (r && r.fileID) || ''
  if (!id) throw new Error('上传未返回 fileID')
  return id
}

/** 压缩 + 体积闸门：压完量一次，超上限就用 q40 从原图再压一次，取更小的那个 */
async function squeeze(src, w, h, longSide, quality, maxBytes) {
  let path = await compressOne(src, w, h, longSide, quality)
  let size = await fileSize(path)
  if (size && size > maxBytes) {
    console.warn('[media] 压缩后仍偏大', Math.round(size / 1024) + 'KB', '→ 降档重压', longSide)
    const p2 = await compressOne(src, w, h, longSide, 40)
    const s2 = await fileSize(p2)
    if (s2 && s2 < size) {
      if (path !== src) unlink(path)
      path = p2
      size = s2
    } else if (p2 !== src && p2 !== path) {
      unlink(p2)
    }
  }
  return { path, size }
}

/**
 * 把选中的图变成 posts.images[]（含双档上传）
 *
 * @param {string} petId
 * @param {Array<{path,w,h}>} picked pickImages 的结果
 * @param {Function} [onStep] (index, total, stage) stage: 'compress' | 'upload'
 * @returns {Promise<Array<{fileID,thumbID,w,h,localPath,bytes}>>}
 *          localPath 仅用于「上传期间的乐观预览」，调用方在发布完成 / 关闭弹层时 unlink
 *          bytes = { thumb, full } 字节数，用于成本观测（真实档位是否生效）
 */
async function buildPostImages(petId, picked, onStep) {
  const list = Array.isArray(picked) ? picked.slice(0, MAX_ALBUM) : []
  const step = typeof onStep === 'function' ? onStep : () => {}
  const out = []

  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    step(i, list.length, 'compress')

    // 1) 路径规整（DevTools 的 http://tmp 必须落盘）
    const local = await toLocal(it.path)
    // 2) 尺寸：chooseMedia 已给，缺失再问一次（1 张图按原比例排版要用）
    let w = Number(it.w) || 0
    let h = Number(it.h) || 0
    if (!w || !h) {
      const info = await getInfo(local)
      w = info.w
      h = info.h
    }

    // 3) 双档压缩（带体积闸门）
    const th = await squeeze(local, w, h, THUMB_LONG, THUMB_Q, THUMB_MAX_BYTES)
    const fu = await squeeze(local, w, h, FULL_LONG, FULL_Q, FULL_MAX_BYTES)
    console.log('[media] 压缩结果 thumb=' + Math.round(th.size / 1024) + 'KB full='
      + Math.round(fu.size / 1024) + 'KB 原图=' + Math.round((Number(it.size) || 0) / 1024) + 'KB')

    // 4) 上传（thumb 与 full 各一份，路径与现有 pet/ avatar/ 同级风格）
    step(i, list.length, 'upload')
    const stamp = uniqName('x')
    const base = `posts/${petId}/${stamp}`
    const fullID = await uploadOne(fu.path, base)
    let thumbID = ''
    try {
      thumbID = await uploadOne(th.path, `posts/${petId}/thumb_${stamp}`)
    } catch (e) {
      // thumb 失败不该让整条发布失败：退化成「列表也用 full」，只是费点流量
      console.warn('[media] thumb 上传失败，列表回落 full（流量会放大 ~6 倍）', e)
      thumbID = fullID
    }

    out.push({
      fileID: fullID,
      thumbID,
      w,
      h,
      localPath: local,
      bytes: { thumb: th.size || 0, full: fu.size || 0 }
    })
    // 压缩产物是临时文件，微信会自己回收；落盘的副本由调用方统一 unlink
    unlink([th.path, fu.path].filter((p) => p && p !== local))
  }
  return out
}

/** 读本地文件字节数（失败返回 0，不阻断） */
function fileSize(path) {
  const fs = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null
  if (!fs || !path || isHttp(path)) return Promise.resolve(0)
  return U.withTimeout(new Promise((resolve) => {
    try {
      fs.stat({
        path,
        success: (r) => resolve((r && r.stats && r.stats.size) || 0),
        fail: () => resolve(0)
      })
    } catch (e) { resolve(0) }
  }), 4000, '读取文件大小').catch(() => 0)
}

/**
 * 生成并上传「小头像」，返回 fileID
 *
 * ⚠️ 这是可选优化：失败一律回落主头像（只是费点流量），绝不能让「改头像」整个失败。
 * ⚠️ 原图本身就比目标小（scale>=1，compressOne 会直接返回原路径）时返回 ''，
 *    调用方用主头像兜底 —— 否则会把同一张大图传两遍。
 *
 * @param {string} cloudPath 小头像要存的云路径（与主头像同目录、加 _s 后缀）
 * @param {string} localPath 已落盘的本地图
 * @param {number} w @param {number} h 原图尺寸（用于等比缩放，没有就自行探测）
 * @returns {Promise<string>} 失败 / 无需生成 → ''
 */
async function buildAvatarSmall(cloudPath, localPath, w, h) {
  try {
    let iw = Number(w) || 0
    let ih = Number(h) || 0
    if (!iw || !ih) {
      const info = await getInfo(localPath)
      iw = info.w
      ih = info.h
    }
    const p = await compressOne(localPath, iw, ih, AVATAR_SMALL_LONG, AVATAR_SMALL_Q)
    if (p === localPath) return ''          // 没缩小 = 原图已经够小，不需要再传一份
    const id = await uploadOne(p, cloudPath)
    unlink(p)
    return id
  } catch (e) {
    console.warn('[media] 小头像生成失败，回落主头像', e)
    return ''
  }
}

/**
 * 云文件 ID → 临时 https 链接
 *
 * ⚠️ `wx.previewImage` 只吃 http(s)，**不接受 `cloud://` fileID**
 *    （`<image src>` 支持 fileID，所以列表能显示、点开却白屏 —— 最容易漏的一处）
 * ⚠️ 存储权限必须是「所有用户可读」，否则共享成员拿到的是空 tempFileURL
 *
 * @param {string[]} fileIDs
 * @returns {Promise<string[]>} 与入参等长；失败的位为 ''（调用方自行过滤并保持索引映射）
 */
const _tempCache = {}          // fileID -> { url, exp }
const TEMP_TTL = 90 * 60 * 1000
const TEMP_BATCH = 50          // getTempFileURL 单次上限

async function toTempUrls(fileIDs) {
  const ids = (Array.isArray(fileIDs) ? fileIDs : []).map((x) => String(x || ''))
  const out = new Array(ids.length).fill('')
  const now = Date.now()
  const miss = []
  ids.forEach((id, i) => {
    if (!id) return
    if (id.indexOf('cloud://') !== 0) { out[i] = id; return }   // 已是 http 或本地路径
    const c = _tempCache[id]
    if (c && c.exp > now) { out[i] = c.url; return }
    miss.push(i)
  })
  if (!miss.length) return out

  for (let s = 0; s < miss.length; s += TEMP_BATCH) {
    const slice = miss.slice(s, s + TEMP_BATCH)
    try {
      const r = await U.withTimeout(
        wx.cloud.getTempFileURL({ fileList: slice.map((i) => ids[i]) }),
        12000,
        '获取图片链接'
      )
      const list = (r && r.fileList) || []
      list.forEach((f, k) => {
        const i = slice[k]
        const url = (f && f.tempFileURL) || ''
        if (!url) return
        out[i] = url
        _tempCache[ids[i]] = { url, exp: Date.now() + TEMP_TTL }
      })
    } catch (e) {
      // 整批失败就当这些位拿不到：调用方会跳过，不会传空串进 previewImage
      console.error('[media] getTempFileURL 失败', e)
    }
  }
  return out
}

module.exports = {
  MAX_TIMELINE,
  MAX_ALBUM,
  THUMB_LONG,
  FULL_LONG,
  AVATAR_SMALL_LONG,
  pickImages,
  buildPostImages,
  buildAvatarSmall,
  toLocal,
  toTempUrls,
  fileSize,
  unlink
}
