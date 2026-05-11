// v-click-outside — fires the bound function when a click lands outside
// the element. Used for closing dropdown menus.
//
// Subtle bug fixed here: when the user clicks the toggle button to OPEN
// a dropdown, the click bubbles to document. If the directive listens
// on `click`, that bubble fires the close callback immediately and the
// dropdown re-closes on the same tick.
//
// We listen on `mousedown` instead — the toggle's own click handler
// runs on `click` (after `mouseup`), so by the time it fires,
// mousedown-based "outside" detection has already finished and the
// dropdown stays open. We still ignore mousedown that lands inside
// the directive's element so clicks within the menu don't dismiss it.
export const clickOutside = {
  beforeMount(el, binding) {
    el._clickOutside = (e) => {
      if (!(el === e.target || el.contains(e.target))) {
        binding.value(e)
      }
    }
    // defer so the directive's own mount-time click doesn't fire it
    setTimeout(() => document.addEventListener('mousedown', el._clickOutside), 0)
  },
  unmounted(el) {
    document.removeEventListener('mousedown', el._clickOutside)
  }
}
