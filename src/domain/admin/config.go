package admin

import (
	"context"
	"time"
)

type ResourceConfig struct {
	ID               string
	Name             string
	AssetType        string
	Region           string
	Location         string
	Capacity         int
	IsRestricted     bool
	RequiresApproval bool
}

type Holiday struct {
	ID          string
	Date        time.Time
	Description string
	IsBlocker   bool
}

type AdminRepository interface {
	CreateResource(ctx context.Context, config ResourceConfig) error
	AddHoliday(ctx context.Context, holiday Holiday) error
	IsDateHoliday(ctx context.Context, date time.Time) (bool, error)
}
