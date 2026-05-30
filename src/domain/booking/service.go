package booking

import "context"

// Service represents a bookable add-on, like catering or equipment,
// that can be attached to a booking.
type Service struct {
	ID          string
	TenantID    string
	CategoryID  string
	Name        string
	Description string
	Price       float64
	IsActive    bool
}

// ServiceRepository defines the persistence interface for services.
type ServiceRepository interface {
	Save(ctx context.Context, s *Service) error
	FindByID(ctx context.Context, id string) (*Service, error)
	ListByTenant(ctx context.Context, tenantID string) ([]*Service, error)
	Delete(ctx context.Context, id string) error
}
