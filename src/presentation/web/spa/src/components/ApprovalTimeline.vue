<template>
  <!-- Compact: single-line dots + n/N + SLA chip (list rows) -->
  <div v-if="compact" class="atl-compact" :title="summary">
    <span class="atl-dot start done" />
    <template v-for="(s, i) in nodes" :key="i">
      <span class="atl-bar" :class="s.cls" />
      <span class="atl-dot" :class="s.cls">
        <Check v-if="s.cls === 'done'" :size="9" />
        <X v-else-if="s.cls === 'rejected'" :size="9" />
        <Slash v-else-if="s.cls === 'skipped'" :size="9" />
        <template v-else>{{ i + 1 }}</template>
      </span>
    </template>
    <span class="atl-meta">{{ decidedCount }}/{{ nodes.length }}</span>
    <span v-if="slaChip" class="pill" :class="slaChip.cls">{{ slaChip.text }}</span>
  </div>

  <!-- Full timeline -->
  <div v-else class="atl">
    <div class="atl-node">
      <div class="atl-circle done"><Check :size="13" /></div>
      <div class="atl-cap">
        <b>Submitted</b>
        <small v-if="submittedAt">{{ fmt(submittedAt) }}</small>
      </div>
    </div>

    <template v-for="(s, i) in nodes" :key="i">
      <div class="atl-link" :class="s.linkCls" />
      <div class="atl-node">
        <div class="atl-circle" :class="s.cls">
          <Check v-if="s.cls === 'done'" :size="13" />
          <X v-else-if="s.cls === 'rejected'" :size="13" />
          <Slash v-else-if="s.cls === 'skipped'" :size="13" />
          <Clock v-else-if="s.cls === 'current'" :size="13" />
          <template v-else>{{ i + 1 }}</template>
        </div>
        <div class="atl-cap">
          <b>{{ s.title }}</b>
          <small v-if="s.actor">{{ s.actor }}<template v-if="s.when"> · {{ fmt(s.when) }}</template></small>
          <small v-else-if="s.cls === 'current'" class="atl-sla" :class="{ over: s.overdue }">
            {{ s.slaText }}
          </small>
          <small v-else class="muted">{{ s.sub }}</small>
          <div v-if="s.reason" class="atl-reason" :class="{ bad: s.cls === 'rejected' }">
            “{{ s.reason }}”
          </div>
        </div>
      </div>
    </template>

    <div class="atl-link" :class="resultLinkCls" />
    <div class="atl-node">
      <div class="atl-circle" :class="resultCls">
        <Check v-if="resultCls === 'done'" :size="13" />
        <X v-else-if="resultCls === 'rejected'" :size="13" />
        <template v-else>—</template>
      </div>
      <div class="atl-cap"><b>{{ resultLabel }}</b></div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Check, X, Slash, Clock } from 'lucide-vue-next'

const props = defineProps({
  steps: { type: Array, default: () => [] },
  submittedAt: { type: [String, Number, Date], default: null },
  compact: { type: Boolean, default: false }
})

// Normalise PascalCase approval.Step into render nodes. The first pending
// step is "current"; later pending steps are "upcoming".
const nodes = computed(() => {
  let currentSeen = false
  return (props.steps || []).map((st) => {
    const status = (st.Status || st.status || 'pending').toLowerCase()
    const decidedBy = st.DecidedBy || st.decided_by || ''
    const decisionAt = st.DecisionAt || st.decision_at || null
    const reason = st.Reason || st.reason || ''
    const due = st.DueAt || st.due_at || null
    const role = st.ApproverRole || st.approver_role || ''
    const name = st.LevelName || st.level_name || ('Step ' + ((st.StepIndex ?? 0) + 1))
    let cls = 'upcoming'
    if (status === 'approved') cls = 'done'
    else if (status === 'rejected') cls = 'rejected'
    else if (status === 'skipped') cls = 'skipped'
    else if (!currentSeen) { cls = 'current'; currentSeen = true }

    let slaText = '', overdue = false
    if (cls === 'current' && due) {
      const ms = new Date(due).getTime() - Date.now()
      overdue = ms < 0
      slaText = overdue
        ? `SLA breached ${human(-ms)} ago`
        : `Awaiting${role ? ' ' + role : ''} · ${human(ms)} left`
    } else if (cls === 'current') {
      slaText = `Awaiting${role ? ' ' + role : ''}`
    }

    return {
      title: name,
      cls,
      linkCls: (cls === 'done' || cls === 'skipped') ? 'done' : (cls === 'rejected' ? 'rejected' : ''),
      actor: (cls === 'done' || cls === 'rejected') ? (decidedBy || '—') : '',
      when: decisionAt,
      sub: cls === 'skipped' ? 'Not required' : (role ? role : 'Pending'),
      reason: (cls === 'rejected' || (cls === 'done' && reason)) ? reason : '',
      slaText, overdue
    }
  })
})

const decidedCount = computed(() =>
  nodes.value.filter(n => n.cls === 'done' || n.cls === 'rejected' || n.cls === 'skipped').length)

const anyRejected = computed(() => nodes.value.some(n => n.cls === 'rejected'))
const allDone = computed(() =>
  nodes.value.length > 0 && nodes.value.every(n => n.cls === 'done' || n.cls === 'skipped'))

const resultCls = computed(() => anyRejected.value ? 'rejected' : (allDone.value ? 'done' : 'upcoming'))
const resultLinkCls = computed(() => anyRejected.value ? 'rejected' : (allDone.value ? 'done' : ''))
const resultLabel = computed(() =>
  anyRejected.value ? 'Rejected' : (allDone.value ? 'Confirmed' : 'Pending'))

const slaChip = computed(() => {
  const cur = nodes.value.find(n => n.cls === 'current')
  if (!cur || !cur.slaText) return null
  return { text: cur.overdue ? 'Overdue' : cur.slaText.replace(/^Awaiting[^·]*· /, ''), cls: cur.overdue ? 'bad' : 'amber' }
})

const summary = computed(() =>
  nodes.value.map((n, i) => `${i + 1}. ${n.title}: ${n.cls}`).join('\n'))

function human(ms) {
  const m = Math.round(Math.abs(ms) / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
function fmt(d) {
  return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.atl { display: flex; align-items: flex-start; gap: 0; overflow-x: auto; padding: 6px 0; }
.atl-node { display: flex; flex-direction: column; align-items: center; min-width: 110px; text-align: center; }
.atl-circle {
  width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
  font-size: 12px; font-weight: 700; background: #fff;
  border: 2px solid var(--asl-line, #dbe1ea); color: var(--asl-grey, #64748b);
}
.atl-circle.done { background: var(--asl-ok, #059669); border-color: var(--asl-ok, #059669); color: #fff; }
.atl-circle.rejected { background: var(--asl-bad, #dc2626); border-color: var(--asl-bad, #dc2626); color: #fff; }
.atl-circle.current { background: var(--asl-amber, #d97706); border-color: var(--asl-amber, #d97706); color: #fff; animation: atl-pulse 1.6s ease-in-out infinite; }
.atl-circle.skipped { background: #f1f3f5; border-style: dashed; }
@keyframes atl-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,119,6,.45); } 50% { box-shadow: 0 0 0 6px rgba(217,119,6,0); } }
.atl-cap { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; padding: 0 6px; }
.atl-cap b { font-size: 12px; }
.atl-cap small { font-size: 11px; color: var(--asl-grey, #64748b); }
.atl-sla { color: var(--asl-amber, #d97706); font-weight: 600; }
.atl-sla.over { color: var(--asl-bad, #dc2626); }
.atl-reason { font-size: 11px; font-style: italic; color: var(--asl-grey, #64748b); margin-top: 2px; max-width: 160px; }
.atl-reason.bad { color: var(--asl-bad, #dc2626); }
.atl-link { flex: 1; min-width: 28px; height: 2px; background: var(--asl-line, #dbe1ea); margin-top: 13px; }
.atl-link.done { background: var(--asl-ok, #059669); }
.atl-link.rejected { background: var(--asl-bad, #dc2626); }

.atl-compact { display: inline-flex; align-items: center; gap: 4px; }
.atl-compact .atl-dot {
  width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center;
  font-size: 9px; font-weight: 700; background: #fff;
  border: 1px solid var(--asl-line, #dbe1ea); color: var(--asl-grey, #64748b);
}
.atl-compact .atl-dot.done { background: var(--asl-ok, #059669); border-color: var(--asl-ok, #059669); color: #fff; }
.atl-compact .atl-dot.rejected { background: var(--asl-bad, #dc2626); border-color: var(--asl-bad, #dc2626); color: #fff; }
.atl-compact .atl-dot.current { background: var(--asl-amber, #d97706); border-color: var(--asl-amber, #d97706); color: #fff; }
.atl-compact .atl-dot.skipped { background: #f1f3f5; }
.atl-compact .atl-bar { width: 14px; height: 2px; background: var(--asl-line, #dbe1ea); }
.atl-compact .atl-bar.done { background: var(--asl-ok, #059669); }
.atl-compact .atl-bar.rejected { background: var(--asl-bad, #dc2626); }
.atl-compact .atl-meta { font-size: 11px; color: var(--asl-grey, #64748b); margin-left: 4px; }
.pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; margin-left: 4px; }
.pill.amber { background: var(--asl-amber-bg, #fef3c7); color: var(--asl-amber, #d97706); }
.pill.bad { background: var(--asl-bad-bg, #fee2e2); color: var(--asl-bad, #dc2626); }
</style>
