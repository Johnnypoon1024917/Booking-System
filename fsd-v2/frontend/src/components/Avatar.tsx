import { useMemo } from 'react';

interface Props {
  name?: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
}

// Port of v1's Avatar.vue. Falls back to up-to-two initials when no
// image is provided, with a deterministic colour gradient derived from
// the name so the same user is always the same colour across pages.
export function Avatar({ name = '', src, size = 'md' }: Props) {
  const initials = useMemo(() => {
    if (!name) return '·';
    return name.trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  }, [name]);

  const background = useMemo(() => {
    if (!name) return undefined;
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = ((hash * 31 + name.charCodeAt(i)) >>> 0);
    const hue = hash % 360;
    return `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${(hue + 32) % 360} 70% 55%))`;
  }, [name]);

  if (src) {
    return <img className={`avatar avatar-${size}`} src={src} alt={name} title={name} />;
  }
  return (
    <div className={`avatar avatar-${size}`} style={{ background }} title={name}>
      {initials}
    </div>
  );
}
