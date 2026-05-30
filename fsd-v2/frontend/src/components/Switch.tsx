interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}

// Accessible controlled toggle — `role="switch"` plus `aria-checked` so
// screen readers announce it as a toggle rather than a generic button.
// Visual styling matches v1's Switch.vue (40x22 pill, 18px thumb).
export function Switch({ checked, onChange, disabled, label }: Props) {
  return (
    <button
      type="button"
      className={`sw${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="thumb" />
    </button>
  );
}
