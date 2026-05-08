package admin

import "time"

// ResourceConfig handles the tools to configure departments, regions, locations, and individual room parameters.
type ResourceConfig struct {
	ID               string
	Name             string
	AssetType        string
	Region           string
	Location         string
	Capacity         int
	IsRestricted     bool // Handles Restricted Rooms: "VIP/Admin Only" visibility[cite: 33].
	RequiresApproval bool // Handles Special Rooms requiring a one-level approval workflow[cite: 32].
}

// Holiday handles the manual addition/editing of holidays.
type Holiday struct {
	ID          string
	Date        time.Time
	Description string
	IsBlocker   bool // Defines if this prevents bookings
}

type AdminRepository interface {
	CreateResource(config ResourceConfig) error
	AddHoliday(holiday Holiday) error
	IsDateHoliday(date time.Time) (bool, error)
}
