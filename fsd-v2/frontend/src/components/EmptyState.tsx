import { ReactNode } from 'react';
import { Inbox, LucideIcon } from 'lucide-react';

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
}

// Port of v1's EmptyState.vue — icon disc + title + optional helper
// text + optional CTA slot. Use this anywhere a list/table is empty so
// the page never just shows blank space.
export function EmptyState({ icon: Icon = Inbox, title, description, actions }: Props) {
  return (
    <div className="empty">
      <div className="icon-wrap">
        <Icon size={24} />
      </div>
      <h4>{title}</h4>
      {description && <p>{description}</p>}
      {actions && <div className="mt">{actions}</div>}
    </div>
  );
}
