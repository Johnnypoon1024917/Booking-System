package usecase

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"fsd-mrbs/src/domain/booking"
)

// CheckinTokenStore persists single-use QR check-in tokens.
type CheckinTokenStore interface {
	Issue(ctx context.Context, tenantID, bookingID string, expiresAt time.Time, token string) error
	Resolve(ctx context.Context, token string) (tenantID, bookingID string, expiresAt time.Time, consumed bool, err error)
	Consume(ctx context.Context, token string) error
}

// CheckinUseCase produces a QR token at booking time and consumes it when
// the user scans the kiosk display. Tokens are short, opaque, single-use,
// and tenant-scoped.
type CheckinUseCase struct {
	tokens   CheckinTokenStore
	bookings booking.Repository
	ttl      time.Duration
}

func NewCheckinUseCase(tokens CheckinTokenStore, bookings booking.Repository) *CheckinUseCase {
	return &CheckinUseCase{tokens: tokens, bookings: bookings, ttl: 24 * time.Hour}
}

// IssueToken creates a fresh token and stores it. Caller embeds the token
// in a QR code displayed on the booking confirmation page.
func (uc *CheckinUseCase) IssueToken(ctx context.Context, tenantID, bookingID string, validUntil time.Time) (string, error) {
	if validUntil.IsZero() {
		validUntil = time.Now().Add(uc.ttl)
	}
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if err := uc.tokens.Issue(ctx, tenantID, bookingID, validUntil, token); err != nil {
		return "", err
	}
	return token, nil
}

// Redeem marks the booking as Checked In if the token is valid and unconsumed.
func (uc *CheckinUseCase) Redeem(ctx context.Context, token string) (string, error) {
	if token == "" {
		return "", errors.New("missing token")
	}
	tenantID, bookingID, exp, consumed, err := uc.tokens.Resolve(ctx, token)
	if err != nil {
		return "", err
	}
	if consumed {
		return "", errors.New("token already used")
	}
	if time.Now().After(exp) {
		return "", errors.New("token expired")
	}
	b, err := uc.bookings.FindByID(ctx, bookingID)
	if err != nil {
		return "", err
	}
	if b.TenantID != "" && b.TenantID != tenantID {
		return "", errors.New("token tenant mismatch")
	}
	now := time.Now()
	b.Status = booking.StatusCheckedIn
	b.CheckedInAt = &now
	if err := uc.bookings.Save(ctx, b); err != nil {
		return "", err
	}
	if err := uc.tokens.Consume(ctx, token); err != nil {
		// Booking is already saved; consume failure shouldn't undo it.
		return bookingID, nil
	}
	return bookingID, nil
}

func randomToken() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
