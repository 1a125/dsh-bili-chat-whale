/** 发弹幕频率档位：低档沿用原来的保守设置。 */
export const FREQUENCY_PRESETS = {
  low: { label: '低', maxPerRoom: 5, minGapSec: 75, maxPerHour: 15, maxPerDay: 40, speakIntervalSec: 150 },
  medium: { label: '中', maxPerRoom: 10, minGapSec: 45, maxPerHour: 30, maxPerDay: 80, speakIntervalSec: 90 },
  high: { label: '高', maxPerRoom: 20, minGapSec: 25, maxPerHour: 60, maxPerDay: 150, speakIntervalSec: 45 },
}

export function normalizeFrequency(value) {
  return Object.hasOwn(FREQUENCY_PRESETS, value) ? value : 'low'
}

export function effectiveInteraction(interaction = {}) {
  const frequency = normalizeFrequency(interaction.frequency)
  return { ...interaction, ...FREQUENCY_PRESETS[frequency], frequency }
}
