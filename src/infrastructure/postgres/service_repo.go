package postgres

import (
	"context"
	"fsd-mrbs/src/domain/booking"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ServiceRepo struct {
	db *pgxpool.Pool
}

func NewServiceRepository(db *pgxpool.Pool) *ServiceRepo {
	return &ServiceRepo{db: db}
}

func (r *ServiceRepo) Save(ctx context.Context, s *booking.Service) error {
	if s.ID == "" {
		s.ID = uuid.New().String()
	}
	const query = `
INSERT INTO services (id, tenant_id, category_id, name, description, price, is_active)
VALUES ($1, $2, NULLIF($3,'')::uuid, $4, $5, $6, $7)
ON CONFLICT (id) DO UPDATE
SET category_id = EXCLUDED.category_id,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price = EXCLUDED.price,
    is_active = EXCLUDED.is_active`

	_, err := r.db.Exec(ctx, query, s.ID, s.TenantID, s.CategoryID, s.Name, s.Description, s.Price, s.IsActive)
	return err
}

func (r *ServiceRepo) FindByID(ctx context.Context, id string) (*booking.Service, error) {
	s := &booking.Service{}
	err := r.db.QueryRow(ctx, "SELECT id, tenant_id, COALESCE(category_id::text,''), name, description, price, is_active FROM services WHERE id = $1", id).Scan(&s.ID, &s.TenantID, &s.CategoryID, &s.Name, &s.Description, &s.Price, &s.IsActive)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (r *ServiceRepo) ListByTenant(ctx context.Context, tenantID string) ([]*booking.Service, error) {
	rows, err := r.db.Query(ctx, "SELECT id, tenant_id, COALESCE(category_id::text,''), name, description, price, is_active FROM services WHERE tenant_id = $1 ORDER BY name", tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var services []*booking.Service
	for rows.Next() {
		s := &booking.Service{}
		if err := rows.Scan(&s.ID, &s.TenantID, &s.CategoryID, &s.Name, &s.Description, &s.Price, &s.IsActive); err != nil {
			return nil, err
		}
		services = append(services, s)
	}
	return services, nil
}

func (r *ServiceRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, "DELETE FROM services WHERE id = $1", id)
	return err
}
