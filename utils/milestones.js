/**
 * 档案衍生里程碑（PRD 5.4.1 / 5.4.1.1）：不落库，由档案字段实时派生
 * - 生日   →「出生那天」+ 每年生日周年「N 岁啦」
 * - 到家日 →「回家那天」+ 每年到家周年「在一起 N 年」
 * - 初始体重 →「第一次上秤」（按到家日或建档日归档）
 *
 * ⚠️ 文案唯一数据源是 MS_COPY —— 页面 / 组件禁止硬编码任何里程碑文案，
 *    也禁止把带变量的文案写成字面量（否则会渲染出「N 岁啦」四个字）
 */
const U = require('./util')

/**
 * 里程碑文案映射表（PRD 5.4.1.1 定稿）
 *
 * key = 里程碑 type（birthday / home / weight）
 *  - label：卡片左侧类型标签（静态）
 *  - base ：本体，即第 0 年（出生那天 / 回家那天 / 第一次上秤）
 *  - anniv：周年，即第 N 年；title / desc 收 n 作为入参
 *
 * 四条文案原则（改文案时必须同时满足）：
 *   ① desc 不复述数据 —— 日期已显示在卡片右上角，desc 只回答"那天意味着什么"
 *   ② 标签用叙事时态 —— 时间线是故事线，用「出生那天」而非表单字段名「出生」
 *   ③ 统一中性称呼「它」—— 禁用「毛孩子」「崽崽」等哺乳宠专属称呼
 *   ④ 整套只留一个「啦」（N 岁啦）—— 一个「啦」是重音，四个「啦」是噪音
 *
 * 全部 desc ≤ 12 字
 */
const MS_COPY = {
  birthday: {
    label: '生日',
    tagClass: 'tag-bd',
    icon: '🎂',
    base: {
      title: () => '出生那天',
      desc: () => '一切，从这天开始'
    },
    anniv: {
      title: (n) => `${n} 岁啦`,
      desc: (n) => `陪你的第 ${n} 年`
    }
  },
  home: {
    label: '到家日',
    tagClass: 'tag-home',
    icon: '🏠',
    base: {
      title: () => '回家那天',
      desc: () => '从这天起，它有家了'
    },
    anniv: {
      title: (n) => `在一起 ${n} 年`,
      desc: (n) => (n === 1 ? '你们的故事，讲了一整年' : '你们的故事，又多了一年')
    }
  },
  weight: {
    label: '体重',
    tagClass: 'tag-wt',
    icon: '⚖️',
    base: {
      title: () => '第一次上秤',
      desc: () => '小小一只有了第一个数字'
    }
  }
}

function createdAtDate(pet) {
  // 建档日：优先 createdAt（云 serverDate），兜底今天
  let s = ''
  if (pet.createdAt) {
    try {
      const d = pet.createdAt instanceof Date ? pet.createdAt : new Date(pet.createdAt)
      if (!isNaN(d.getTime())) s = U.fmtDate(d)
    } catch (e) { /* 忽略 */ }
  }
  return s || U.todayStr()
}

/** 取某类型的文案片段：years=0 走 base，>0 走 anniv */
function copyOf(type, years) {
  const c = MS_COPY[type] || MS_COPY.weight
  return years > 0 && c.anniv ? c.anniv : c.base
}

/** 某字段的全部周年事件（含第 0 年本体） */
function anniversaries(baseDate, type) {
  if (!baseDate) return []
  const today = U.todayStr()
  const out = []
  const [by, bm, bd] = baseDate.split('-').map(Number)
  const curYear = Number(today.split('-')[0])
  for (let y = by; y <= curYear; y++) {
    // 2/29 兜底为 2/28
    const isLeap = new Date(y, 1, 29).getDate() === 29
    const md = (bm === 2 && bd === 29 && !isLeap) ? '02-28' : `${U.pad(bm)}-${U.pad(bd)}`
    const date = `${y}-${md}`
    if (date > today) break
    const years = y - by
    const c = copyOf(type, years)
    out.push({
      type,
      date,
      title: c.title(years),
      desc: c.desc(years),
      auto: true
    })
  }
  return out
}

/**
 * 派生一只宠物的全部里程碑（按 date 倒序）
 * @returns {Array} { _id, kind:'milestone', type, date, title, desc, auto, isBackfill }
 */
function derive(pet) {
  if (!pet) return []
  const createdAt = createdAtDate(pet)
  const list = []

  anniversaries(pet.birthday, 'birthday').forEach((m) => list.push(m))
  anniversaries(pet.adoptDay, 'home').forEach((m) => list.push(m))

  // 初始体重（档案字段 weight，旧档案为 initWeight）：有值才生成「第一次上秤」
  // ⚠️ 日期锚点按 PRD 取「到家日 || 建档日」，**不是**体重录入当天。所以档案里今天
  //    补填初始体重，这条里程碑可能落在几个月前的到家日 —— 这是既定口径，不是 bug。
  const firstWeight = U.initWeightOf(pet)
  if (firstWeight) {
    const anchor = pet.adoptDay || createdAt
    const c = MS_COPY.weight.base
    list.push({
      type: 'weight',
      date: anchor,
      title: c.title(),
      desc: c.desc(),
      auto: true
    })
  }

  return list
    .map((m, i) => ({
      ...m,
      _id: `ms_${pet._id}_${m.type}_${m.date}_${i}`,
      kind: 'milestone',
      // PRD 5.4.1.1：判定保留供点击提示判断来源，但不再渲染成角标
      isBackfill: m.date < createdAt
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

/** 里程碑样式（供页面渲染，颜色取自 MS_COPY 单一数据源） */
function style(type) {
  const c = MS_COPY[type] || MS_COPY.weight
  return { label: c.label, tagClass: c.tagClass, icon: c.icon }
}

module.exports = { derive, style, createdAtDate, MS_COPY }
