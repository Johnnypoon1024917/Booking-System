// Package visitor models pre-registered guests visiting the premises.
//
// A Visit is created by an MRBS user (the "host") for a named guest,
// optionally anchored to a booking. The lifecycle is:
//
//	Expected -> Checked In -> Checked Out
//
// or any of those -> Cancelled / No Show as a terminal state.
//
// QR-based redemption follows the same pattern as booking check-in:
// the host shares a one-shot token, reception or a kiosk scans the QR,
// the server verifies the token hash and flips status to Checked In.
package visitor

import (
	"context"
	"time"
)

const (
	StatusExpected    = "Expected"
	StatusCheckedIn   = "Checked In"
	StatusCheckedOut  = "Checked Out"
	StatusNoShow      = "No Show"
	StatusCancelled   = "Cancelled"
)

// Visit is the canonical representation. Plain Go time.Time values are
// stored as TIMESTAMPTZ; nullable timestamps are represented with
// pointers so the JSON encoding stays clean.
type Visit struct {
	ID               string
	TenantID         string
	BookingID        string // optional
	HostUserID       string
	VisitorName      string
	VisitorEmail     string
	VisitorPhone     string
	VisitorCompany   string
	VisitorIDType    string
	VisitorIDLast4   string
	Purpose          string
	ExpectedAt       time.Time
	ExpectedUntil    *time.Time
	Status           string
	CheckedInAt      *time.Time
	CheckedOutAt     *time.Time
	HealthDeclaration map[string]interface{}
	NDAAccepted      bool
	Notes            string
	TokenHash        string
	TokenExpiresAt   *time.Time
	CreatedBy        string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Repository abstracts the persistence so we can stub it out in tests.
type Repository interface {
	Save(ctx context.Context, v Visit) error
	FindByID(ctx context.Context, tenantID, id string) (*Visit, error)
	FindByTokenHash(ctx context.Context, tokenHash string) (*Visit, error)
	ListForHost(ctx context.Context, tenantID, hostUserID string, from, to time.Time) ([]Visit, error)
	ListForTenant(ctx context.Context, tenantID string, from, to time.Time, status string) ([]Visit, error)
	UpdateStatus(ctx context.Context, tenantID, id, status string, at time.Time) error
}
