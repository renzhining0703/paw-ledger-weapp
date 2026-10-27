/**
 * 云函数 petRemove：删除宠物并事务性级联删除其下全部记录（PRD 7.1）
 * 避免前端多次调用中断产生脏数据
 *
 * 二期收口后：owner 判定改用 petMembers(role=owner)，不再依赖 _openid
 * 删除范围：记录集合 + petMembers + invites + pets
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const BUILD = '20261026-posts'

/**
 * ⚠️ posts（图文/相册）必须在这里一起清：
 * 只删集合记录不删云存储文件 = 用户删了宠物，照片还永久占着容量且再也无法从界面触达。
 */
const RECORD_COLS = ['health', 'weights', 'daily', 'expenses', 'posts']

async function removeWhere(col, petId) {
  let removed = 0
  for (;;) {
    const r = await db.collection(col).where({ petId }).limit(100).get()
    if (!r.data.length) break
    await Promise.all(r.data.map((d) => db.collection(col).doc(d._id).remove()))
    removed += r.data.length
    if (r.data.length < 100) break
  }
  return removed
}

/** 收集某宠物 posts 里的全部文件 ID（thumb + full） */
async function collectPostFiles(petId) {
  const files = []
  let skip = 0
  for (;;) {
    const r = await db.collection('posts').where({ petId }).skip(skip).limit(100).get()
    if (!r.data.length) break
    r.data.forEach((p) => {
      ;(p.images || []).forEach((im) => {
        if (im && im.thumbID) files.push(im.thumbID)
        if (im && im.fileID) files.push(im.fileID)
      })
    })
    skip += r.data.length
    if (r.data.length < 100) break
  }
  return files
}

/** 分批删云存储（deleteFile 单次上限 50）；失败只记日志，不阻塞记录删除 */
async function removeFiles(files) {
  let failed = 0
  for (let i = 0; i < files.length; i += 50) {
    try {
      await cloud.deleteFile({ fileList: files.slice(i, i + 50) })
    } catch (e) {
      failed += Math.min(50, files.length - i)
      console.error('[petRemove] deleteFile 失败（记录照删）', e)
    }
  }
  return failed
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const petId = event.petId
  if (!petId) return { errCode: 1, errMsg: '缺少 petId' }
  console.log('[petRemove] build =', BUILD, 'petId =', petId)

  // 校验归属：查 petMembers role=owner（收口后 owner 判定以它为准）
  const mRes = await db.collection('petMembers')
    .where({ petId, _openid: OPENID, status: 'active' })
    .limit(1).get()
  const member = mRes.data[0]
  if (!member) return { errCode: 2, errMsg: '宠物不存在或无权操作' }
  if (member.role !== 'owner') return { errCode: 3, errMsg: '仅创建者可删除宠物' }

  // 先统计（供前端二次确认文案写明「N 位成员将同时失去数据」）
  const counts = {}
  for (const col of RECORD_COLS) {
    const c = await db.collection(col).where({ petId }).count()
    counts[col] = c.total
  }

  // ⚠️ 文件必须在删记录**之前**收集：记录一删就查不到 fileID，照片会永久留在云存储
  let files = []
  try {
    files = await collectPostFiles(petId)
    // 宠物头像（含上传时顺带生成的小图档）也要收：不收就变成永远删不掉的孤儿文件
    const pr = await db.collection('pets').doc(petId).get().catch(() => null)
    const pv = (pr && pr.data) || {}
    if (pv.avatar) files.push(pv.avatar)
    if (pv.avatarSmall && pv.avatarSmall !== pv.avatar) files.push(pv.avatarSmall)
  } catch (e) {
    console.error('[petRemove] 收集图文文件失败', e)
  }

  // 级联删除
  const removed = {}
  for (const col of RECORD_COLS) {
    removed[col] = await removeWhere(col, petId)
  }
  let fileFailed = 0
  if (files.length) {
    fileFailed = await removeFiles(files)
    console.log('[petRemove] 云存储文件', files.length, '个，失败', fileFailed)
  }

  // 删成员关系与待用邀请
  await removeWhere('petMembers', petId)
  await removeWhere('invites', petId)
  await db.collection('pets').doc(petId).remove()

  return {
    errCode: 0,
    recordCount: Object.values(counts).reduce((s, n) => s + n, 0),
    removed,
    removedFiles: files.length - fileFailed,
    fileFailed
  }
}
