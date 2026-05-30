-- 029_webauthn_credentials.up.sql
--
-- WebAuthn / passkey credentials. A user can register multiple
-- credentials (laptop fingerprint, phone passkey, hardware key) and
-- present any of them in place of the TOTP code.
--
-- Fields follow the WebAuthn / FIDO2 §6 PublicKeyCredentialDescriptor
-- shape: credential_id is the relying-party-opaque handle the browser
-- returns from navigator.credentials.create(); public_key is the
-- CBOR-encoded COSE_Key the server uses to verify assertions; sign_count
-- monotonically increases per use and lets us detect cloned keys.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID NOT NULL,
    credential_id   BYTEA NOT NULL,
    public_key      BYTEA NOT NULL,
    sign_count      BIGINT NOT NULL DEFAULT 0,
    transports      TEXT,                          -- e.g. "usb,nfc,internal"
    aaguid          UUID,                          -- authenticator model id
    nickname        TEXT,                          -- user-facing label
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,
    UNIQUE (tenant_id, credential_id)
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- RLS — same shape as the rest of Phase 4.
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webauthn_credentials;
CREATE POLICY tenant_isolation ON webauthn_credentials
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));
DROP POLICY IF EXISTS service_role_full_access ON webauthn_credentials;
CREATE POLICY service_role_full_access ON webauthn_credentials TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

-- Pending challenges. WebAuthn ceremonies require a server-issued
-- challenge that the authenticator signs; we keep it in a separate
-- table so the SPA's stateless login flow can resume in any replica.
-- TTL is short (5 min); a scheduler tick purges expired rows.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    challenge   TEXT PRIMARY KEY,                  -- base64url
    user_id     UUID,                              -- nullable for registration discovery
    tenant_id   UUID,
    purpose     TEXT NOT NULL,                     -- 'register' | 'authenticate'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes'
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);
