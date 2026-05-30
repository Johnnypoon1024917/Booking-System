-- 023_push_subscriptions.up.sql
--
-- Stores the per-user Web Push (W3C Push API) subscriptions issued by
-- the browser. Each subscription is a (endpoint, p256dh, auth) triple
-- the API hands to the push service to deliver a notification.
--
-- Subscriptions are user-scoped, not session-scoped: a single user
-- typically registers one subscription per browser/device. We keep the
-- whole set so notifications fan out to all of them. Unsubscribing the
-- browser deletes the row via DELETE /api/v1/me/push/<endpoint-hash>.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL,
    user_id      UUID NOT NULL,
    endpoint     TEXT NOT NULL,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
