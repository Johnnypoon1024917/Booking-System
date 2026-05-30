import { NotificationTemplateType } from './notification-template.entity';

// Localisation for system-generated emails and push notifications.
//
// Admins can override per-tenant templates (in any language) via the Tenant
// Studio Locale tab; those overrides win. But when no override exists we fall
// back to these built-in defaults, localised to the *recipient's* preferred
// language (User.locale, frozen into the outbox row at enqueue time) instead
// of always emitting English. Injected enum values like Status are likewise
// mapped to a localised label before substitution so a Chinese-speaking user
// never sees a raw English database enum such as "Pending Approval".

export type NotificationLocale = 'en' | 'zh-Hant' | 'zh-Hans';

const SUPPORTED: NotificationLocale[] = ['en', 'zh-Hant', 'zh-Hans'];

// normalizeLocale coerces a stored/raw locale string to a supported locale,
// defaulting to English. Accepts common variants (e.g. zh-TW → zh-Hant,
// zh-CN → zh-Hans) so values synced from SSO/LDAP still resolve.
export function normalizeLocale(raw?: string | null): NotificationLocale {
  if (!raw) return 'en';
  const v = raw.trim();
  if ((SUPPORTED as string[]).includes(v)) return v as NotificationLocale;
  const lower = v.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant') return 'zh-Hant';
  if (lower === 'zh-cn' || lower === 'zh-sg' || lower === 'zh-hans' || lower === 'zh') return 'zh-Hans';
  return 'en';
}

// Booking status enum (booking.entity BookingStatus) → localised label.
const STATUS_LABELS: Record<NotificationLocale, Record<string, string>> = {
  en: {
    Confirmed: 'Confirmed',
    'Pending Approval': 'Pending Approval',
    Cancelled: 'Cancelled',
    'Checked In': 'Checked In',
    'No Show': 'No Show',
    Attended: 'Attended',
    Exception: 'Exception',
  },
  'zh-Hant': {
    Confirmed: '已確認',
    'Pending Approval': '待審批',
    Cancelled: '已取消',
    'Checked In': '已簽到',
    'No Show': '未出席',
    Attended: '已出席',
    Exception: '異常',
  },
  'zh-Hans': {
    Confirmed: '已确认',
    'Pending Approval': '待审批',
    Cancelled: '已取消',
    'Checked In': '已签到',
    'No Show': '未出席',
    Attended: '已出席',
    Exception: '异常',
  },
};

// localizeStatus maps a raw booking status enum to its localised label,
// falling back to the raw value if unknown (forward-compatible with new
// statuses added before this table is updated).
export function localizeStatus(status: string, locale: NotificationLocale): string {
  return STATUS_LABELS[locale]?.[status] ?? STATUS_LABELS.en[status] ?? status;
}

interface LocalizedTemplate { subject: string; body: string }

const DEFAULT_TEMPLATES: Record<NotificationLocale, Record<NotificationTemplateType, LocalizedTemplate>> = {
  en: {
    confirmation: {
      subject: 'Booking {{Status}}: {{ResourceName}}',
      body: `<p>Hello {{UserName}},</p>
<p>Your booking for <strong>{{ResourceName}}</strong> is now <strong>{{Status}}</strong>.</p>
<ul>
  <li>Start: {{StartTime}}</li>
  <li>End: {{EndTime}}</li>
</ul>
<p>The attached calendar invite (.ics) will update your Outlook / Gmail automatically.</p>`,
    },
    cancellation: {
      subject: 'Booking cancelled: {{ResourceName}}',
      body: `<p>Hello {{UserName}},</p>
<p>Your booking for <strong>{{ResourceName}}</strong> has been <strong>cancelled</strong>.</p>
<ul>
  <li>Start: {{StartTime}}</li>
  <li>End: {{EndTime}}</li>
</ul>
<p>The attached calendar cancellation (.ics) will remove the event from your calendar automatically.</p>`,
    },
    reminder: {
      subject: 'Reminder: {{ResourceName}} at {{StartTime}}',
      body: `<p>Hello {{UserName}},</p>
<p>This is a reminder for your upcoming booking of <strong>{{ResourceName}}</strong>.</p>
<ul>
  <li>Start: {{StartTime}}</li>
  <li>End: {{EndTime}}</li>
</ul>`,
    },
  },
  'zh-Hant': {
    confirmation: {
      subject: '預訂{{Status}}：{{ResourceName}}',
      body: `<p>{{UserName}} 您好，</p>
<p>您預訂的 <strong>{{ResourceName}}</strong> 目前狀態為 <strong>{{Status}}</strong>。</p>
<ul>
  <li>開始：{{StartTime}}</li>
  <li>結束：{{EndTime}}</li>
</ul>
<p>隨附的行事曆邀請 (.ics) 將自動更新您的 Outlook / Gmail。</p>`,
    },
    cancellation: {
      subject: '預訂已取消：{{ResourceName}}',
      body: `<p>{{UserName}} 您好，</p>
<p>您預訂的 <strong>{{ResourceName}}</strong> 已被<strong>取消</strong>。</p>
<ul>
  <li>開始：{{StartTime}}</li>
  <li>結束：{{EndTime}}</li>
</ul>
<p>隨附的行事曆取消通知 (.ics) 將自動從您的行事曆移除此活動。</p>`,
    },
    reminder: {
      subject: '提醒：{{ResourceName}} 於 {{StartTime}}',
      body: `<p>{{UserName}} 您好，</p>
<p>提醒您即將到來的預訂 <strong>{{ResourceName}}</strong>。</p>
<ul>
  <li>開始：{{StartTime}}</li>
  <li>結束：{{EndTime}}</li>
</ul>`,
    },
  },
  'zh-Hans': {
    confirmation: {
      subject: '预订{{Status}}：{{ResourceName}}',
      body: `<p>{{UserName}} 您好，</p>
<p>您预订的 <strong>{{ResourceName}}</strong> 当前状态为 <strong>{{Status}}</strong>。</p>
<ul>
  <li>开始：{{StartTime}}</li>
  <li>结束：{{EndTime}}</li>
</ul>
<p>随附的日历邀请 (.ics) 将自动更新您的 Outlook / Gmail。</p>`,
    },
    cancellation: {
      subject: '预订已取消：{{ResourceName}}',
      body: `<p>{{UserName}} 您好，</p>
<p>您预订的 <strong>{{ResourceName}}</strong> 已被<strong>取消</strong>。</p>
<ul>
  <li>开始：{{StartTime}}</li>
  <li>结束：{{EndTime}}</li>
</ul>
<p>随附的日历取消通知 (.ics) 将自动从您的日历中移除此活动。</p>`,
    },
    reminder: {
      subject: '提醒：{{ResourceName}} 于 {{StartTime}}',
      body: `<p>{{UserName}} 您好，</p>
<p>提醒您即将到来的预订 <strong>{{ResourceName}}</strong>。</p>
<ul>
  <li>开始：{{StartTime}}</li>
  <li>结束：{{EndTime}}</li>
</ul>`,
    },
  },
};

// defaultTemplate returns the built-in template for a type in the given
// locale, falling back to English for any gap.
export function defaultTemplate(locale: NotificationLocale, type: NotificationTemplateType): LocalizedTemplate {
  return DEFAULT_TEMPLATES[locale]?.[type] ?? DEFAULT_TEMPLATES.en[type];
}

// Push notification copy. Short title/body templates substituted with the
// same (already-localised) vars as the email.
const PUSH_MESSAGES: Record<NotificationLocale, Record<'confirmation' | 'cancellation', LocalizedTemplate>> = {
  en: {
    confirmation: { subject: 'Booking {{Status}}', body: '{{ResourceName}}' },
    cancellation: { subject: 'Booking cancelled', body: '{{ResourceName}}' },
  },
  'zh-Hant': {
    confirmation: { subject: '預訂{{Status}}', body: '{{ResourceName}}' },
    cancellation: { subject: '預訂已取消', body: '{{ResourceName}}' },
  },
  'zh-Hans': {
    confirmation: { subject: '预订{{Status}}', body: '{{ResourceName}}' },
    cancellation: { subject: '预订已取消', body: '{{ResourceName}}' },
  },
};

// pushMessage returns the raw push title/body templates for an event type
// (reminder folds into the confirmation style).
export function pushMessage(locale: NotificationLocale, type: NotificationTemplateType): LocalizedTemplate {
  const set = PUSH_MESSAGES[locale] ?? PUSH_MESSAGES.en;
  return type === 'cancellation' ? set.cancellation : set.confirmation;
}
