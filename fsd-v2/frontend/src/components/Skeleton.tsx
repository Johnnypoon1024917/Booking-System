import { CSSProperties } from 'react';

interface Props {
  width?: string;
  height?: string;
  radius?: string;
  style?: CSSProperties;
}

// Port of v1's Skeleton.vue. Pair with the shimmer keyframe defined in
// index.css (added alongside this component).
export function Skeleton({ width = '100%', height = '14px', radius = '4px', style }: Props) {
  return (
    <div
      className="skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}
