/**
 * 隐藏彩蛋：特别关注的主播开播时，只给它的房间加一点排序权重。
 * 不强制进入、不打断当前直播间，也不绕过分区/人气/重复进入冷却。
 * 不在设置页展示。
 */
export const SPECIAL_UID = '3546640893872412'
export const SPECIAL_WEIGHT = 50
export const SPECIAL_CHECK_MS = 60_000
