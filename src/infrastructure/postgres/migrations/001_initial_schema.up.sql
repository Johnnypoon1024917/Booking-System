-- ============================================================================
-- FSD-MRBS Initial Schema Migration (Up)
-- ============================================================================
-- This migration creates the complete database schema for the Room Booking System
-- including multi-tenant isolation, row-level security, and all required indexes.
-- ============================================================================

-- Enable UUID generation for primary keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TENANTS TABLE (Multi-Tenant Isolation)
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',  -- 'active', 'suspended', 'deleted'
    branding_config JSONB DEFAULT '{}',             -- {logo_url, color_scheme, etc.}
    identity_provider_config JSONB DEFAULT '{}',    -- {type: 'ldap'|'saml'|'oauth2', config: {...}}
    approval_config JSONB DEFAULT '{}',             -- {timeout_hours, escalation_enabled, etc.}
    booking_limits JSONB DEFAULT '{}',              -- {default_limit: 10, role_limits: {...}}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- USERS TABLE (Identity & RBAC)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(255) NOT NULL,
    dn VARCHAR(500),                                -- Distinguished Name from AD
    role VARCHAR(50) NOT NULL DEFAULT 'General User',
    grade VARCHAR(50),                              -- For Secretary role visibility
    is_active BOOLEAN DEFAULT TRUE,
    region_access TEXT[],                           -- For Room Admin role: list of regions
    last_sync_at TIMESTAMP,                         -- Last sync from identity provider
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, username)
);

-- ============================================================================
-- RESOURCES TABLE (Bookable Assets)
-- ============================================================================
CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    asset_type VARCHAR(50) NOT NULL,                -- 'Room', 'Vehicle', 'Equipment', 'Top Management'
    region VARCHAR(100) NOT NULL,
    location VARCHAR(255) NOT NULL,
    capacity INT DEFAULT 0,
    equipment JSONB DEFAULT '[]',                   -- ["Projector", "Video Conferencing"]
    metadata JSONB DEFAULT '{}',                    -- Extensible properties
    is_restricted BOOLEAN DEFAULT FALSE,
    requires_approval BOOLEAN DEFAULT FALSE,
    approver_ids UUID[] DEFAULT '{}',               -- Array of user IDs for approval
    secretary_ids UUID[] DEFAULT '{}',              -- For Top Management resources
    is_active BOOLEAN DEFAULT TRUE,
    version INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- RECURRING SERIES TABLE (Must be created before bookings due to FK)
-- ============================================================================
CREATE TABLE IF NOT EXISTS recurring_series (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pattern VARCHAR(50) NOT NULL,                   -- 'daily', 'weekly', 'bi-weekly', 'monthly'
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,                         -- Calculated from max 100 occurrences
    time_start TIME NOT NULL,
    time_end TIME NOT NULL,
    day_of_week INT[],                              -- For weekly patterns: [1,2,3,4,5]
    day_of_month INT,                               -- For monthly patterns: 1-31
    status VARCHAR(50) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- BOOKINGS TABLE (Core Booking Engine)
-- ============================================================================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Confirmed',
    is_recurring BOOLEAN DEFAULT FALSE,
    recurrence_id UUID REFERENCES recurring_series(id),
    exception_notes TEXT,
    meeting_url TEXT,                               -- Original Zoom/Teams URL
    redirect_url TEXT,                              -- Masked static URL
    checked_in_at TIMESTAMP,
    version INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- HOLIDAYS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS holidays (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    holiday_date DATE NOT NULL,
    description VARCHAR(255) NOT NULL,
    is_blocker BOOLEAN DEFAULT TRUE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, holiday_date)
);

-- ============================================================================
-- AUDIT ENTRIES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_user_id UUID REFERENCES users(id),
    action_type VARCHAR(100) NOT NULL,              -- 'BOOKING_CREATED', 'ROLE_CHANGED', etc.
    target_entity VARCHAR(100) NOT NULL,            -- 'booking', 'user', 'resource'
    target_id UUID,
    previous_state JSONB,
    new_state JSONB,
    ip_address INET,
    user_agent TEXT
);

-- ============================================================================
-- MEETING REDIRECTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS meeting_redirects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    static_url VARCHAR(500) NOT NULL UNIQUE,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- BROADCASTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS broadcasts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    image_url VARCHAR(500),
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP NOT NULL,
    filters JSONB DEFAULT '{}',                      -- {resources: [], locations: [], date_range: {}}
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ROLE CONFIGS TABLE (Per-Tenant Custom Roles)
-- ============================================================================
CREATE TABLE IF NOT EXISTS role_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role_name VARCHAR(100) NOT NULL,
    booking_limit INT DEFAULT 10,
    permissions JSONB DEFAULT '{}',                  -- {can_view_restricted: true, etc.}
    is_custom BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, role_name)
);

-- ============================================================================
-- NOTIFICATION TEMPLATES TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS notification_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    template_type VARCHAR(50) NOT NULL,             -- 'confirmation', 'cancellation', 'reminder'
    subject VARCHAR(255) NOT NULL,
    body_template TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- WEEKEND CONFIGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS weekend_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    weekend_days INT[] DEFAULT '{6,7}',             -- 1=Monday, 7=Sunday; default Sat/Sun
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id)
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE OPTIMIZATION
-- ============================================================================

-- Multi-tenant isolation (apply to all tenant-scoped tables)
CREATE INDEX idx_bookings_tenant ON bookings(tenant_id);
CREATE INDEX idx_resources_tenant ON resources(tenant_id);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_holidays_tenant ON holidays(tenant_id);
CREATE INDEX idx_audit_tenant ON audit_entries(tenant_id);
CREATE INDEX idx_recurring_series_tenant ON recurring_series(tenant_id);
CREATE INDEX idx_broadcasts_tenant ON broadcasts(tenant_id);
CREATE INDEX idx_meeting_redirects_tenant ON meeting_redirects(tenant_id);
CREATE INDEX idx_role_configs_tenant ON role_configs(tenant_id);
CREATE INDEX idx_notification_templates_tenant ON notification_templates(tenant_id);
CREATE INDEX idx_weekend_configs_tenant ON weekend_configs(tenant_id);

-- Conflict detection optimization
CREATE INDEX idx_bookings_conflict ON bookings(resource_id, start_time, end_time, status);

-- Search optimization
CREATE INDEX idx_resources_search ON resources(tenant_id, asset_type, region, capacity);
CREATE INDEX idx_bookings_user_status ON bookings(tenant_id, user_id, status);

-- Audit trail queries
CREATE INDEX idx_audit_timestamp ON audit_entries(tenant_id, timestamp);
CREATE INDEX idx_audit_actor ON audit_entries(tenant_id, actor_user_id);
CREATE INDEX idx_audit_action ON audit_entries(tenant_id, action_type);

-- Recurring series lookups
CREATE INDEX idx_recurring_series_resource ON recurring_series(tenant_id, resource_id);
CREATE INDEX idx_recurring_series_user ON recurring_series(tenant_id, user_id);

-- Holiday lookups by date
CREATE INDEX idx_holidays_date ON holidays(tenant_id, holiday_date);

-- Broadcast active period queries
CREATE INDEX idx_broadcasts_active ON broadcasts(tenant_id, start_date, end_date);

-- ============================================================================
-- ROW-LEVEL SECURITY FOR MULTI-TENANCY
-- ============================================================================

-- Enable RLS on all tenant-scoped tables
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekend_configs ENABLE ROW LEVEL SECURITY;

-- Create policies for each table
-- Note: The app.current_tenant_id setting must be set by the application
-- during each database session using: SET app.current_tenant_id = '<tenant-uuid>';

CREATE POLICY tenant_isolation_bookings ON bookings
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_resources ON resources
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_users ON users
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_holidays ON holidays
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_audit ON audit_entries
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_recurring_series ON recurring_series
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_broadcasts ON broadcasts
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_meeting_redirects ON meeting_redirects
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_role_configs ON role_configs
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_notification_templates ON notification_templates
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

CREATE POLICY tenant_isolation_weekend_configs ON weekend_configs
    USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);

-- ============================================================================
-- TRIGGER FOR UPDATED_AT TIMESTAMP
-- ============================================================================

-- Create a function to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply the trigger to tables with updated_at column
CREATE TRIGGER update_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_resources_updated_at
    BEFORE UPDATE ON resources
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bookings_updated_at
    BEFORE UPDATE ON bookings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
