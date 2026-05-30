import { computed } from 'vue'
import { useTenantStore } from '../stores/tenant'

// Single source of truth for admin-configured booking constraints so the
// Calendar, Advanced Search, New Booking wizard and BookingModal all
// enforce the same rules the System Settings screen persists.
export function useBookingRules() {
  const tenant = useTenantStore()
  const c = computed(() => tenant.customization || {})

  const rules = computed(() => ({
    minMinutes: c.value.min_duration_minutes || 15,
    maxMinutes: c.value.max_duration_minutes || 480,
    horizonDays: c.value.booking_horizon_days || 180,
    weekendDays: c.value.weekend_days || [6, 7],
    weekendRequireApproval: !!c.value.weekend_require_approval,
    patterns: c.value.recurrence_patterns || []
  }))

  // allowsPattern: empty/absent list ⇒ everything allowed.
  function allowsPattern(p) {
    const list = rules.value.patterns
    return !list.length || list.includes(p)
  }

  // validate returns a human-readable reason the booking is not allowed,
  // or '' when it satisfies every configured rule. Accepts a date string
  // (YYYY-MM-DD) plus HH:MM start/end, or full Date objects.
  function validate({ date, start, end, startDate, endDate }) {
    const s = startDate || new Date(`${date}T${start}`)
    const e = endDate || new Date(`${date}T${end}`)
    if (isNaN(s) || isNaN(e)) return 'Invalid date or time.'
    if (e <= s) return 'End time must be after start time.'

    const mins = (e - s) / 60000
    const r = rules.value
    if (mins < r.minMinutes) return `Minimum booking duration is ${r.minMinutes} minutes.`
    if (mins > r.maxMinutes) return `Maximum booking duration is ${Math.round(r.maxMinutes / 60 * 10) / 10} hours.`

    const now = new Date()
    if (s < new Date(now.getTime() - 60000)) return 'Booking start must be in the future.'

    const horizon = new Date(now)
    horizon.setDate(horizon.getDate() + r.horizonDays)
    if (s > horizon) return `Bookings can only be made up to ${r.horizonDays} days in advance.`

    return ''
  }

  // isoWeekday: Mon=1..Sun=7 to match the WeekendDays config.
  function isWeekend(d) {
    const day = d.getDay() // 0=Sun..6=Sat
    const iso = day === 0 ? 7 : day
    return rules.value.weekendDays.includes(iso)
  }

  return { rules, allowsPattern, validate, isWeekend }
}
