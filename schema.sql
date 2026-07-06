-- ============================================================
-- YIELD HARVEST UGANDA - DATABASE SCHEMA
-- ============================================================
-- Designed for: Supabase / PostgreSQL
-- Scale target: ~30,000 beneficiaries now, ~60,000 within 5 years
-- Roles: agent -> super_agent -> program_officer -> admin
-- ============================================================

-- ------------------------------------------------------------
-- EXTENSIONS
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- LOCATION REFERENCE TABLES
-- (kept as proper tables, not free text, so counts/reports work)
-- ------------------------------------------------------------
CREATE TABLE districts (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE subcounties (
    id SERIAL PRIMARY KEY,
    district_id INTEGER NOT NULL REFERENCES districts(id),
    name VARCHAR(100) NOT NULL,
    UNIQUE (district_id, name)
);

CREATE TABLE parishes (
    id SERIAL PRIMARY KEY,
    subcounty_id INTEGER NOT NULL REFERENCES subcounties(id),
    name VARCHAR(100) NOT NULL,
    UNIQUE (subcounty_id, name)
);

CREATE TABLE villages (
    id SERIAL PRIMARY KEY,
    parish_id INTEGER NOT NULL REFERENCES parishes(id),
    name VARCHAR(100) NOT NULL,
    is_refugee_settlement BOOLEAN DEFAULT FALSE, -- covers "block for refugees" case
    UNIQUE (parish_id, name)
);

-- Seed the known districts from the paper form
INSERT INTO districts (name) VALUES
('Kabarole'), ('Kasese'), ('Kamwenge'), ('Kyegegwa'), ('Kikuube'),
('Bunyangabu'), ('Ntoroko'), ('Fort Portal'), ('Isingiro'), ('Kanungu'), ('Rukungiri');

-- ------------------------------------------------------------
-- USERS (agents, super agents, program officers, admins)
-- ------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('agent', 'super_agent', 'program_officer', 'admin');

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(150) NOT NULL,
    phone VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(150) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'agent',
    -- an agent reports to a super_agent; super_agents/officers have this NULL
    supervisor_id UUID REFERENCES users(id),
    district_id INTEGER REFERENCES districts(id), -- primary operating district
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_supervisor ON users(supervisor_id);

-- ------------------------------------------------------------
-- FARMER GROUPS / VSLAs
-- ------------------------------------------------------------
CREATE TABLE farmer_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(150) NOT NULL,
    group_type VARCHAR(30) DEFAULT 'farmer_group', -- farmer_group | vsla | youth_group
    district_id INTEGER REFERENCES districts(id),
    subcounty_id INTEGER REFERENCES subcounties(id),
    parish_id INTEGER REFERENCES parishes(id),
    village_id INTEGER REFERENCES villages(id),
    chairperson_name VARCHAR(150),
    chairperson_phone VARCHAR(20),
    -- which super agent / agent owns / manages this group day-to-day
    managed_by UUID REFERENCES users(id),
    village_agent_id UUID REFERENCES users(id), -- may differ from managed_by
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_groups_managed_by ON farmer_groups(managed_by);
CREATE INDEX idx_groups_district ON farmer_groups(district_id);

-- ------------------------------------------------------------
-- BENEFICIARIES (from the Beneficiary Profile Form)
-- ------------------------------------------------------------
CREATE TYPE gender_type AS ENUM ('male', 'female');
CREATE TYPE education_level AS ENUM (
    'none', 'primary_incomplete', 'primary', 'secondary_o_level',
    'secondary_a_level', 'vocational', 'university_college', 'tertiary', 'other'
);
CREATE TYPE livelihood_category AS ENUM (
    'youth_farmer', 'vsla_member', 'youth_agent', 'youth_entrepreneur',
    'youth_group_member', 'training_enrollee', 'other'
);

CREATE TABLE beneficiaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- identity
    full_name VARCHAR(150) NOT NULL,
    gender gender_type,
    date_of_birth DATE,
    year_of_birth INTEGER, -- fallback when exact DOB unknown (form allows "Eg 2017")
    phone VARCHAR(20),

    -- refugee / identification
    is_refugee BOOLEAN DEFAULT FALSE,
    nin_or_refugee_number VARCHAR(50),

    -- location
    district_id INTEGER REFERENCES districts(id),
    subcounty_id INTEGER REFERENCES subcounties(id),
    parish_id INTEGER REFERENCES parishes(id),
    village_id INTEGER REFERENCES villages(id),

    -- program linkage
    farmer_group_id UUID REFERENCES farmer_groups(id),
    project_supporting_profile VARCHAR(150), -- e.g. JESE, Skill Up, etc.
    has_participated_before BOOLEAN DEFAULT FALSE,
    joined_via_cso VARCHAR(150), -- "Through which CSO enabled you to join"
    village_agent_id UUID REFERENCES users(id),

    -- contact / financial access
    has_mobile_phone BOOLEAN,
    mobile_money_registered BOOLEAN,
    has_bank_account BOOLEAN,
    bank_name VARCHAR(150),

    -- group membership detail
    is_vsla_or_group_member BOOLEAN DEFAULT FALSE,
    vsla_name VARCHAR(150),

    -- next of kin
    next_of_kin_name VARCHAR(150),
    next_of_kin_phone VARCHAR(20),

    -- livelihood profiling
    livelihood_category livelihood_category,
    enterprise_crop BOOLEAN DEFAULT FALSE,
    enterprise_animal_rearing BOOLEAN DEFAULT FALSE,
    enterprise_beekeeping BOOLEAN DEFAULT FALSE,
    enterprise_poultry BOOLEAN DEFAULT FALSE,
    enterprise_general_business BOOLEAN DEFAULT FALSE,
    enterprise_other TEXT,

    -- disability
    has_disability BOOLEAN DEFAULT FALSE,
    disability_prefer_not_to_tell BOOLEAN DEFAULT FALSE,
    disability_legs_walking BOOLEAN DEFAULT FALSE,
    disability_vision_eye BOOLEAN DEFAULT FALSE,
    disability_arms_hands BOOLEAN DEFAULT FALSE,
    disability_hearing_speaking BOOLEAN DEFAULT FALSE,
    disability_mental BOOLEAN DEFAULT FALSE,

    -- education
    education_level education_level,

    -- current economic activity (multi-select in form)
    activity_school BOOLEAN DEFAULT FALSE,
    activity_farming BOOLEAN DEFAULT FALSE,
    activity_own_business BOOLEAN DEFAULT FALSE,
    activity_employed BOOLEAN DEFAULT FALSE,
    activity_volunteer_apprentice BOOLEAN DEFAULT FALSE,
    activity_jobless BOOLEAN DEFAULT FALSE,
    activity_household_work BOOLEAN DEFAULT FALSE,

    -- access
    has_land_access VARCHAR(10), -- yes | no | dont_know
    has_capital_access VARCHAR(10), -- yes | no | dont_know

    -- consent + media
    consent_share_with_third_party BOOLEAN DEFAULT FALSE,
    photo_url TEXT,

    -- interview metadata
    interviewer_name VARCHAR(150),
    interviewer_phone VARCHAR(20),
    registered_by UUID REFERENCES users(id), -- app user who captured this record
    registered_at TIMESTAMPTZ DEFAULT now(),

    -- sync bookkeeping (for offline-first mobile app)
    client_uuid UUID, -- id generated on-device before sync, to prevent duplicates
    synced_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_beneficiaries_client_uuid ON beneficiaries(client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX idx_beneficiaries_group ON beneficiaries(farmer_group_id);
CREATE INDEX idx_beneficiaries_district ON beneficiaries(district_id);
CREATE INDEX idx_beneficiaries_registered_by ON beneficiaries(registered_by);
CREATE INDEX idx_beneficiaries_is_refugee ON beneficiaries(is_refugee);
CREATE INDEX idx_beneficiaries_has_disability ON beneficiaries(has_disability);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_beneficiaries_name_search ON beneficiaries USING gin (full_name gin_trgm_ops);

-- ------------------------------------------------------------
-- TRAINING SESSIONS (from the Training Form)
-- ------------------------------------------------------------
CREATE TABLE training_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    farmer_group_id UUID NOT NULL REFERENCES farmer_groups(id),
    activity_date DATE NOT NULL,
    activity_description TEXT,
    training_topics TEXT,
    activity_venue VARCHAR(200),
    district_id INTEGER REFERENCES districts(id),
    subcounty_id INTEGER REFERENCES subcounties(id),
    village_agent_id UUID REFERENCES users(id),
    village_agent_phone VARCHAR(20),
    facilitator_name VARCHAR(150),
    facilitator_signature_url TEXT, -- captured signature image, if digitized

    recorded_by UUID REFERENCES users(id),
    client_uuid UUID,
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_training_client_uuid ON training_sessions(client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX idx_training_group ON training_sessions(farmer_group_id);
CREATE INDEX idx_training_date ON training_sessions(activity_date);

-- ------------------------------------------------------------
-- TRAINING ATTENDANCE (links beneficiaries to a session)
-- This replaces re-typing names on every paper form.
-- ------------------------------------------------------------
CREATE TABLE training_attendance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    training_session_id UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
    beneficiary_id UUID NOT NULL REFERENCES beneficiaries(id),

    -- snapshot flags at time of attendance (in case profile changes later,
    -- the training record should still reflect what was true that day)
    is_pwd_snapshot BOOLEAN DEFAULT FALSE,
    is_refugee_snapshot BOOLEAN DEFAULT FALSE,
    attestation_no VARCHAR(50),
    signed BOOLEAN DEFAULT FALSE,
    signature_url TEXT,

    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (training_session_id, beneficiary_id)
);

CREATE INDEX idx_attendance_session ON training_attendance(training_session_id);
CREATE INDEX idx_attendance_beneficiary ON training_attendance(beneficiary_id);

-- ------------------------------------------------------------
-- AUDIT LOG (lightweight — useful once donors start asking
-- "who entered this record and when")
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    action VARCHAR(50) NOT NULL, -- create | update | delete
    table_name VARCHAR(50) NOT NULL,
    record_id UUID,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
