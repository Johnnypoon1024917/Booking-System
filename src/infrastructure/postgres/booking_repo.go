package postgres

import (
	"context"
	"fsd-mrbs/src/domain/booking"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type BookingRepo struct {
	db *pgxpool.Pool
}

func NewBookingRepository(db *pgxpool.Pool) *BookingRepo {
	return &BookingRepo{db: db}
}

func (r *BookingRepo) IsAvailable(ctx context.Context, roomID string, start, end time.Time) (bool, error) {
	query := `
		SELECT COUNT(1) FROM bookings 
		WHERE room_id = $1 AND status = 'CONFIRMED'
		AND (start_time < $3 AND end_time > $2)`

	var count int
	err := r.db.QueryRow(ctx, query, roomID, start, end).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == 0, nil
}

func (r *BookingRepo) Save(ctx context.Context, b *booking.Booking) error {
	query := `
		INSERT INTO bookings (id, room_id, user_id, start_time, end_time, status, version, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
		ON CONFLICT (id) DO UPDATE 
		SET status = EXCLUDED.status, version = bookings.version + 1
		WHERE bookings.version = $8`

	cmdTag, err := r.db.Exec(ctx, query, b.ID, b.RoomID, b.UserID, b.StartTime, b.EndTime, b.Status, b.CreatedAt, b.Version)
	if err != nil {
		return err
	}
	if cmdTag.RowsAffected() == 0 {
		return booking.ErrConcurrencyConflict
	}
	return nil
}
