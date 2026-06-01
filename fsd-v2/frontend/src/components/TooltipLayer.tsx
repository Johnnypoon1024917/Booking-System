import { useTooltip } from '../stores/tooltip';

// Single fixed-position tooltip rendered at the app root. Positioned just above
// and to the right of the cursor; the transform keeps it from sitting under the
// pointer or running off the right edge for short labels. pointer-events: none
// (in CSS) so it never intercepts hover/click on what's beneath it.
export function TooltipLayer() {
  const { text, x, y, show } = useTooltip();
  if (!show || !text) return null;
  return (
    <div className="tooltip-pop" role="tooltip" style={{ left: x, top: y }}>
      {text}
    </div>
  );
}
