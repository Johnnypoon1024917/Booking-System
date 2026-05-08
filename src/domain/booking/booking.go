package booking

import (
	"time"
)

// FSD Specific Booking Statuses [cite: 344, 347, 374]
const (
	StatusPendingApproval = "Pending Approval" // For Special Rooms [cite: 357]
	StatusConfirmed       = "Confirmed"
	StatusCheckedIn       = "Checked In" //
	StatusNoShow          = "No Show"    //
	StatusException       = "Exception"  // Typhoon Signal No. 8 override
)

type Booking struct {
	ID             string
	ResourceID     string
	UserID         string
	StartTime      time.Time
	EndTime        time.Time
	Status         string
	IsRecurring    bool   // [cite: 343]
	ExceptionNotes string // Notes for Typhoon/No-Show exceptions
	Version        int
	CreatedAt      time.Time
}
