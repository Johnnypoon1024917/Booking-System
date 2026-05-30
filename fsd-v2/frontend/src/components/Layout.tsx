import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Flame, Gauge, Calendar, Plus, Menu as MenuIcon,
  BarChart3, Settings,
  Bell, Globe, Check, ChevronDown,
  User, LogOut, BookOpen, Clock, CheckCircle,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../hooks/useT';
import { useRealtime } from '../hooks/useRealtime';
import { api } from '../api/client';
import { BroadcastBanner } from './BroadcastBanner';
import { AdminSubnav } from './AdminSubnav';
import { Avatar } from './Avatar';
import { useTenant } from '../stores/tenant';

interface Notif { id: string; kind: string; title: string; at: number; bookingId?: string; }

// Persistent shell — ported verbatim from v1's App.vue + Sidebar.vue +
// TopBar.vue. The narrow 92-px icon-stack sidebar (light variant) +
// 48-px utility topbar give the React SPA the same look as the Vue SPA.
export function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { t, i18n } = useT();
  const brand = useTenant((s) => s.customization) || {};
  const modules: string[] = brand.sidebar_modules || [];
  const show = (k: string) => !modules.length || modules.includes(k);
  const canAdmin = isAdmin();
  // Approvers = admins + Secretary (SDO). They need the Approvals link to act
  // on pending bookings; general users don't see it to avoid nav clutter (#15).
  const canApprove = canAdmin || user?.role === 'Secretary';
  const inAdmin = pathname.startsWith('/admin/') || pathname === '/admin';
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 880;

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [clock, setClock] = useState('');
  const langRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  // --- Notifications ---------------------------------------------
  // Ported from v1's TopBar.vue: seed the bell from /bookings/mine, track
  // acknowledged ids in localStorage (an id-set, not a "last read"
  // timestamp, so WS-pushed events don't reappear), and append live
  // booking events from the realtime SSE stream.
  const readKey = `fsd_notif_read:${user?.username || 'anon'}`;
  const readIds = useRef<Set<string>>(new Set());
  const [notifications, setNotifications] = useState<Notif[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const { lastEvent } = useRealtime();

  function persistReadIds() {
    try { localStorage.setItem(readKey, JSON.stringify(Array.from(readIds.current).slice(-500))); } catch { /* ignore */ }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(readKey);
      readIds.current = new Set(raw ? JSON.parse(raw) : []);
    } catch { readIds.current = new Set(); }
    if (!user) return;
    setNotifLoading(true);
    api.myBookings().then((list: any[]) => {
      setNotifications((list || []).slice(0, 6).map((b) => ({
        id: String(b.id),
        kind: b.status === 'Pending Approval' ? 'warning'
          : b.status === 'Cancelled' || b.status === 'No Show' ? 'error' : 'success',
        title: `${b.status}: booking at ${new Date(b.startTime).toLocaleString()}`,
        at: new Date(b.createdAt).getTime(),
        bookingId: b.id,
      })).filter((n) => !readIds.current.has(n.id)));
    }).catch(() => undefined).finally(() => setNotifLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.username]);

  // Live booking/weather events from the SSE stream onto the bell.
  useEffect(() => {
    if (!lastEvent?.type) return;
    if (lastEvent.type.startsWith('booking.')) {
      const nid = lastEvent.bookingId ? `ws-booking-${lastEvent.bookingId}` : `ws-${lastEvent.type}-${lastEvent.at || ''}`;
      if (readIds.current.has(nid)) return;
      const verb = lastEvent.type.replace('booking.', '').replace(/_/g, ' ');
      setNotifications((ns) => ns.some((n) => n.id === nid) ? ns
        : [{ id: nid, kind: /cancel|reject/.test(lastEvent.type) ? 'warning' : 'info',
             title: `${verb.charAt(0).toUpperCase()}${verb.slice(1)} booking`, at: Date.now(), bookingId: lastEvent.bookingId }, ...ns]);
    } else if (lastEvent.type === 'weather.signal') {
      const nid = `ws-weather-${lastEvent.payload?.code || 'signal'}`;
      if (readIds.current.has(nid)) return;
      setNotifications((ns) => ns.some((n) => n.id === nid) ? ns
        : [{ id: nid, kind: 'warning', title: `HK Observatory: ${lastEvent.payload?.code || 'signal'}`, at: Date.now() }, ...ns]);
    }
  }, [lastEvent]);

  function markAllRead() {
    for (const n of notifications) readIds.current.add(n.id);
    persistReadIds();
    setNotifications([]);
    setNotifOpen(false);
  }
  function openNotification(n: Notif) {
    setNotifOpen(false);
    if (n.bookingId) nav('/my');
  }
  function relTime(ts: number) {
    if (!ts) return '';
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return `${Math.round(d)}s ago`;
    if (d < 3600) return `${Math.round(d / 60)}m ago`;
    if (d < 86400) return `${Math.round(d / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }
  function dotColor(k: string) {
    return k === 'success' ? 'var(--success)' : k === 'warning' ? 'var(--warning)'
      : k === 'error' ? 'var(--danger)' : 'var(--info)';
  }

  // --- Language --------------------------------------------------
  const availableLocales: string[] = brand.available_locales || ['en', 'zh-Hant', 'zh-Hans'];
  function pickLocale(l: string) { i18n.changeLanguage(l); setLangOpen(false); }
  function labelFor(l: string) { return l === 'zh-Hant' ? '繁體中文' : l === 'zh-Hans' ? '简体中文' : 'English'; }
  function flagFor(l: string) { return l === 'zh-Hant' ? '🇭🇰' : l === 'zh-Hans' ? '🇨🇳' : '🇬🇧'; }

  // Tick the topbar clock every second.
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // Click-outside closes the three menus.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Auto-close mobile drawer on navigation.
  useEffect(() => { setSidebarOpen(false); }, [pathname]);

  if (!user) return <Outlet />;   // login screen renders without shell

  const userName = user.username;
  const userRole = user.role;
  const brandLogo: string | undefined = brand.brand_logo_url;

  function doLogout() {
    setUserOpen(false);
    logout();
    nav('/login');
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <div className="drawer-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      <aside className={`sidebar fsd-side fsd-side-light${sidebarOpen ? ' open' : ''}`}>
        <div className={`fsd-brand${brandLogo ? ' has-image' : ''}`}>
          <div className="logo">
            {brandLogo
              ? <img src={brandLogo} alt="logo" className="brand-img" />
              : <Flame size={16} />}
          </div>
        </div>

        <nav className="fsd-nav">
          {show('dashboard') && (
            <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>
              <Gauge size={22} /><span>Dashboard</span>
            </NavLink>
          )}
          {show('calendar') && (
            <NavLink to="/calendar" className={({ isActive }) => isActive ? 'active' : ''}>
              <Calendar size={22} /><span>Schedule</span>
            </NavLink>
          )}
          {show('search') && (
            <NavLink to="/search" className={({ isActive }) => isActive ? 'active' : ''}>
              <Plus size={22} /><span>New&nbsp;Booking</span>
            </NavLink>
          )}
          {show('my-bookings') && (
            <NavLink to="/my" className={({ isActive }) => isActive ? 'active' : ''}>
              <MenuIcon size={22} /><span>My&nbsp;Bookings</span>
            </NavLink>
          )}
          {canApprove && (
            <NavLink to="/approvals" className={({ isActive }) => isActive ? 'active' : ''}>
              <CheckCircle size={22} /><span>Approvals</span>
            </NavLink>
          )}
          {show('reports') && canAdmin && (
            <NavLink to="/admin/reports" className={({ isActive }) => isActive ? 'active' : ''}>
              <BarChart3 size={22} /><span>Reports</span>
            </NavLink>
          )}
          {/* Broadcasts moved off the top-level sidebar — still reachable
              via Settings → Workspace → Broadcasts so the top nav keeps
              the 7 client items focused. */}
          {show('admin') && canAdmin && (
            <NavLink to="/admin/studio" className={({ isActive }) => isActive ? 'active' : ''}>
              <Settings size={22} /><span>Settings</span>
            </NavLink>
          )}
        </nav>
      </aside>

      <div className="app-main-col fsd-main">
        <header className="topbar fsd-topbar">
          {isMobile && (
            <button className="icon-btn" onClick={() => setSidebarOpen((v) => !v)} aria-label="menu">
              <MenuIcon size={18} />
            </button>
          )}

          <div className="fsd-clock"><Clock size={13} /> {clock}</div>

          <div className="actions">
            <div style={{ position: 'relative' }} ref={langRef}>
              <button className="icon-btn" onClick={() => setLangOpen((v) => !v)} aria-label="language">
                <Globe size={18} />
              </button>
              <div className={`menu${langOpen ? ' open' : ''}`}>
                <div className="menu-header"><b>{t('topbar.language')}</b></div>
                {availableLocales.map((l) => (
                  <button key={l} className="menu-item" onClick={() => pickLocale(l)}>
                    <span style={{ width: 24 }}>{flagFor(l)}</span>
                    <span className="space">{labelFor(l)}</span>
                    {i18n.language === l && <Check size={14} />}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ position: 'relative' }} ref={notifRef}>
              <button className="icon-btn" onClick={() => setNotifOpen((v) => !v)} aria-label="notifications">
                <Bell size={18} />
                {notifications.length > 0 && <span className="badge">{notifications.length}</span>}
              </button>
              <div className={`menu${notifOpen ? ' open' : ''}`} style={{ minWidth: 320 }}>
                <div className="menu-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <b>{t('topbar.notifications')}</b>
                  <button className="btn subtle sm" onClick={markAllRead}>{t('topbar.markAllRead')}</button>
                </div>
                <div className="menu-divider" />
                {notifLoading && <div style={{ padding: 18, textAlign: 'center' }} className="muted text-sm">{t('common.loading')}</div>}
                {!notifLoading && notifications.length === 0 && (
                  <div style={{ padding: 18, textAlign: 'center' }} className="muted text-sm">{t('topbar.noNotifications')}</div>
                )}
                {!notifLoading && notifications.map((n) => (
                  <button key={n.id} className="menu-item" style={{ alignItems: 'flex-start' }} onClick={() => openNotification(n)}>
                    <span className="dot-mini" style={{ background: dotColor(n.kind) }} />
                    <div className="space" style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: 13 }}>{n.title}</div>
                      <small className="muted">{relTime(n.at)}</small>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ position: 'relative' }} ref={userRef}>
              <button className="icon-btn fsd-user-btn" onClick={() => setUserOpen((v) => !v)}>
                <Avatar name={userName} />
                <span className="truncate fsd-user-name">{userName}</span>
                <ChevronDown size={14} />
              </button>
              <div className={`menu${userOpen ? ' open' : ''}`}>
                <div className="menu-header">
                  <b>{userName}</b>
                  <small>{userRole}</small>
                </div>
                <div className="menu-divider" />
                <button className="menu-item" onClick={() => { setUserOpen(false); nav('/profile'); }}>
                  <User size={14} /> Profile
                </button>
                {canAdmin && (
                  <button className="menu-item" onClick={() => { setUserOpen(false); nav('/admin/studio'); }}>
                    <Settings size={14} /> Admin
                  </button>
                )}
                <a className="menu-item" href="/api/docs" target="_blank" rel="noreferrer">
                  <BookOpen size={14} /> API Docs
                </a>
                <div className="menu-divider" />
                <button className="menu-item" onClick={doLogout}>
                  <LogOut size={14} /> Logout
                </button>
              </div>
            </div>
          </div>
        </header>

        <BroadcastBanner />

        <main className="main">
          {inAdmin && <AdminSubnav />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// Re-export Link for pages that still import from this module (none yet,
// but keeps imports tidy if a page wants the in-shell context).
export { Link };
