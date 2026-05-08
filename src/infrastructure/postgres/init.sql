-- Enable UUID generation for primary keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. RESOURCES TABLE (Multi-Asset Extensibility & Admin Config)
-- ============================================================================
CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    asset_type VARCHAR(50) NOT NULL,         -- 'Room', 'Vehicle', 'Equipment', 'Top Management'
    region VARCHAR(100) NOT NULL,            -- e.g., 'Hong Kong', 'Kowloon'
    location VARCHAR(255) NOT NULL,          -- e.g., 'FTLife Tower 18/F'
    capacity INT DEFAULT 0,
    metadata JSONB,                          -- Stores equipment lists, dynamic Zoom URLs, etc.
    is_restricted BOOLEAN DEFAULT FALSE,     -- "VIP/Admin Only" visibility
    requires_approval BOOLEAN DEFAULT FALSE, -- Special Rooms requiring a one-level approval workflow
    version INT DEFAULT 1,                   -- Optimistic locking
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 2. BOOKINGS TABLE (Core Booking Engine & Complex State Machine)
-- ============================================================================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    user_id VARCHAR(50) NOT NULL,            -- Ties to Active Directory ID/Username
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    status VARCHAR(50) NOT NULL,             -- 'Pending Approval', 'Confirmed', 'Checked In', 'No Show', 'Exception'
    is_recurring BOOLEAN DEFAULT FALSE,      -- Supports recurring bookings requirement
    exception_notes TEXT,                    -- Reason for override (e.g., "Typhoon Signal No. 8")
    version INT DEFAULT 1,                   -- Optimistic locking for concurrent FSD rush hours
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indices to heavily optimize the Advanced Search Engine conflict detection
CREATE INDEX IF NOT EXISTS idx_bookings_time_status ON bookings (resource_id, start_time, end_time, status);
CREATE INDEX IF NOT EXISTS idx_resources_search ON resources (asset_type, region, capacity);

-- ============================================================================
-- 3. HOLIDAYS TABLE (Administration & Configuration Module)
-- ============================================================================
CREATE TABLE IF NOT EXISTS holidays (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    holiday_date DATE NOT NULL UNIQUE,       -- Must be unique to prevent duplicate blockers
    description VARCHAR(255) NOT NULL,
    is_blocker BOOLEAN DEFAULT TRUE,         -- Flag to control if this blocks new bookings
    created_by VARCHAR(50),                  -- AD Username of the System Admin who created it
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 4. INITIAL SEED DATA (For Immediate Testing)
-- ============================================================================
-- Seed a standard meeting room
INSERT INTO resources (id, name, asset_type, region, location, capacity, metadata, is_restricted) 
VALUES (
    uuid_generate_v4(), 
    'Command Center Alpha', 
    'Room', 
    'Hong Kong', 
    'FTLife Tower 18/F', 
    20, 
    '{"equipment": ["Video Conferencing", "Projector"]}', 
    FALSE
);

-- Seed a restricted Top Management schedule
INSERT INTO resources (id, name, asset_type, region, location, capacity, metadata, is_restricted) 
VALUES (
    uuid_generate_v4(), 
    'Director General Schedule', 
    'Top Management', 
    'Hong Kong', 
    'HQ', 
    1, 
    '{}', 
    TRUE
);