-- 022_sso_state.up.sql
--
-- Server-side store for OIDC/SAML in-flight state: the PKCE verifier,
-- nonce, expected audience, and IdP-RelayState/InResponseTo correlation
-- key. Each row lives for 10 minutes; the scheduler's retention tick
-- prunes anything older.

CREATE TABLE IF NOT EXISTS sso_state (
    state         TEXT PRIMARY KEY,
    tenant_id     UUID NOT NULL,
    provider      TEXT NOT NULL,         -- 'oidc' | 'saml'
    nonce         TEXT,                  -- OIDC only
    verifier      TEXT,                  -- OIDC PKCE
    request_id    TEXT,                  -- SAML AuthnRequest ID
    redirect_after TEXT,                 -- SPA route to land on after success
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
);

CREATE INDEX IF NOT EXISTS idx_sso_state_expiry ON sso_state(expires_at);
