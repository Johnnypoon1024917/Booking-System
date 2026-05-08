package booking

import (
	"context"
	"time"
)

type Resource struct {
	ID           string
	Name         string
	AssetType    string //
	Location     string
	Capacity     int
	Equipment    []string //
	IsRestricted bool     // [cite: 358]
}

type SearchCriteria struct {
	StartTime time.Time
	EndTime   time.Time
	Region    string
	Capacity  int
	AssetType string
}

type ResourceRepository interface {
	// Finds available resources based on FSD advanced filters
	FindAvailable(ctx context.Context, criteria SearchCriteria) ([]Resource, error)
}
