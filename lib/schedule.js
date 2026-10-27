/**
 * 每日巡游时间段（支持跨天，如 20:00–02:00）。
 * 不在时间段内，调度器会停止抓流/语音/画面/叫醒/巡查，避免空耗 token。
 */
export const DEFAULT_SCHEDULE = {
  enabled: false,
  start: '20:00',
  end: '02:00',
  reportLeadMinutes: 10,
}

export function parseClock(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

const dayKey = (date) => date.toLocaleDateString('en-CA')

function at(day, minutes) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0)
}

function addDays(day, amount) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + amount, 0, 0, 0, 0)
}

export function scheduleState(schedule = DEFAULT_SCHEDULE, now = Date.now()) {
  const current = new Date(now)
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate(), 0, 0, 0, 0)
  if (!schedule?.enabled) {
    return {
      enabled: false,
      active: true,
      workDay: dayKey(today),
      startAt: 0,
      endAt: 0,
      reportAt: 0,
      nextStartAt: 0,
      overnight: false,
    }
  }
  const start = parseClock(schedule.start)
  const end = parseClock(schedule.end)
  if (start === null || end === null || start === end) {
    return {
      enabled: true,
      active: true,
      workDay: dayKey(today),
      startAt: 0,
      endAt: 0,
      reportAt: 0,
      nextStartAt: 0,
      overnight: false,
      invalidWindow: true,
    }
  }
  const lead = Math.max(0, Number(schedule.reportLeadMinutes ?? 10)) * 60_000
  const startToday = at(today, start)
  const endToday = at(today, end)

  if (start < end) {
    const overnight = false
    if (now < startToday.getTime()) {
      return { enabled: true, active: false, workDay: dayKey(today), startAt: startToday.getTime(), endAt: endToday.getTime(), reportAt: endToday.getTime() - lead, nextStartAt: startToday.getTime(), overnight }
    }
    if (now < endToday.getTime()) {
      return { enabled: true, active: true, workDay: dayKey(today), startAt: startToday.getTime(), endAt: endToday.getTime(), reportAt: endToday.getTime() - lead, nextStartAt: startToday.getTime(), overnight }
    }
    const next = addDays(today, 1)
    return { enabled: true, active: false, workDay: dayKey(today), startAt: startToday.getTime(), endAt: endToday.getTime(), reportAt: endToday.getTime() - lead, nextStartAt: addDays(next, 0).getTime() + start * 60_000, overnight }
  }

  // 跨天：20:00 → 次日 02:00
  const yesterday = addDays(today, -1)
  if (now >= startToday.getTime()) {
    const nextDay = addDays(today, 1)
    const endAt = new Date(nextDay.getFullYear(), nextDay.getMonth(), nextDay.getDate(), Math.floor(end / 60), end % 60, 0, 0)
    return { enabled: true, active: true, workDay: dayKey(today), startAt: startToday.getTime(), endAt: endAt.getTime(), reportAt: endAt.getTime() - lead, nextStartAt: startToday.getTime(), overnight: true }
  }
  if (now < endToday.getTime()) {
    const startAt = at(yesterday, start)
    return { enabled: true, active: true, workDay: dayKey(yesterday), startAt: startAt.getTime(), endAt: endToday.getTime(), reportAt: endToday.getTime() - lead, nextStartAt: startAt.getTime(), overnight: true }
  }
  return { enabled: true, active: false, workDay: dayKey(today), startAt: startToday.getTime(), endAt: endToday.getTime(), reportAt: endToday.getTime() - lead, nextStartAt: startToday.getTime(), overnight: true }
}
