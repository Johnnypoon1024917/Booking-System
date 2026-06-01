import { useMemo, useState, useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Building, CalendarDays, Megaphone, Sliders,
  Calendar, GitBranch,
  Boxes, Tag, Network,
  Users as UsersIcon, Lock, KeyRound,
  Webhook, Plug,
  LayoutPanelTop, BookOpen, DoorOpen, ShieldCheck, Cable, ScrollText, LucideIcon,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

interface SubItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roomAdmin?: boolean;
}
interface Group {
  label: string;
  icon: LucideIcon;
  items: SubItem[];
}

const ROOM_ADMIN_ROLES = ['Room Admin', 'System Admin', 'Security Admin'];

const ALL_GROUPS: Group[] = [
  {
    label: 'Workspace', icon: LayoutPanelTop,
    items: [
      { to: '/admin/studio',      label: 'Tenant Studio', icon: Sliders },
      { to: '/admin/departments', label: 'Departments',   icon: Building },
      { to: '/admin/holidays',    label: 'Holidays',      icon: CalendarDays },
      { to: '/admin/broadcasts',  label: 'Broadcasts',    icon: Megaphone },
    ],
  },
  {
    label: 'Bookings', icon: BookOpen,
    items: [
      { to: '/admin/bookings',       label: 'All Bookings',   icon: Calendar, roomAdmin: true },
      { to: '/admin/approval-chain', label: 'Approval Chain', icon: GitBranch },
    ],
  },
  {
    label: 'Resources', icon: DoorOpen,
    items: [
      { to: '/admin/resources',       label: 'Resources',      icon: Boxes, roomAdmin: true },
      { to: '/admin/resource-types',  label: 'Resource Types', icon: Tag },
      { to: '/admin/location-groups', label: 'Room Privilege', icon: Network },
    ],
  },
  {
    label: 'People', icon: ShieldCheck,
    items: [
      { to: '/admin/users',       label: 'Users',       icon: UsersIcon },
      { to: '/admin/permissions', label: 'Permissions', icon: Lock },
      { to: '/admin/scim',        label: 'SCIM',        icon: KeyRound },
      { to: '/admin/audit',       label: 'Audit Log',   icon: ScrollText },
    ],
  },
  {
    label: 'Integrations', icon: Cable,
    items: [
      { to: '/admin/webhooks',     label: 'Webhooks',     icon: Webhook },
      { to: '/admin/integrations', label: 'Integrations', icon: Plug },
    ],
  },
];

// Admin sub-nav — automatically rendered by Layout on any /admin/*
// route. Mirrors v1's AdminSubnav.vue including the role-gated rows.
// Open menus close on click-outside so they don't follow the user when
// they navigate elsewhere.
export function AdminSubnav() {
  const { pathname } = useLocation();
  const role = useAuth((s) => s.user?.role ?? '');
  const isRoomAdmin = ROOM_ADMIN_ROLES.includes(role);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpenKey(null);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Close any open menu after the user navigates.
  useEffect(() => { setOpenKey(null); }, [pathname]);

  const groups = useMemo(() => {
    return ALL_GROUPS.map((g) => {
      const items = g.items.filter((i) => !i.roomAdmin || isRoomAdmin);
      const activeChild = items.some((i) => i.to === pathname);
      return { ...g, items, activeChild };
    }).filter((g) => g.items.length > 0);
  }, [isRoomAdmin, pathname]);

  return (
    <nav className="admin-subnav" aria-label="Admin sections" ref={rootRef}>
      {groups.map((g) => {
        const Icon = g.icon;
        const open = openKey === g.label;
        return (
          <div key={g.label} className={`adm-group${g.activeChild ? ' active' : ''}`}>
            <button
              type="button"
              className="adm-trigger"
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : g.label)}
            >
              <Icon size={14} />
              <span>{g.label}</span>
              <span className="caret">▾</span>
            </button>
            {open && (
              <div className="adm-menu" role="menu">
                {g.items.map((i) => {
                  const ItemIcon = i.icon;
                  return (
                    <NavLink
                      key={i.to}
                      to={i.to}
                      className={({ isActive }) => `adm-item${isActive ? ' active' : ''}`}
                      onClick={() => setOpenKey(null)}
                    >
                      <ItemIcon size={14} />
                      {i.label}
                    </NavLink>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
