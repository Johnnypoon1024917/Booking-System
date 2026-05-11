package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ResourceRepo struct {
	db *pgxpool.Pool
}

func NewResourceRepo(db *pgxpool.Pool) *ResourceRepo {
	return &ResourceRepo{db: db}
}

const resourceColumns = `id, tenant_id, name, asset_type, region, location, capacity, equipment,
    is_restricted, requires_approval, approver_ids, secretary_ids, metadata, is_active, version,
    COALESCE(parent_resource_id::text, ''), COALESCE(composite_mode, ''), sub_resource_count,
    COALESCE(department_id::text, ''),
    COALESCE(booking_mode, 'exclusive'), COALESCE(shared_capacity, 1),
    COALESCE(color, ''), COALESCE(icon, '')`

// FindAvailable executes the search engine with FSD RBAC + composite-aware
// filtering. By default child sub-resources are hidden — the parent is what
// users see in search. Searching "split" mode (capacity smaller than the
// parent) surfaces children when the parent is too big for the request.
func (r *ResourceRepo) FindAvailable(ctx context.Context, c booking.SearchCriteria, requestingUser user.User) ([]booking.Resource, error) {
	query := `
SELECT ` + resourceColumns + `
FROM resources
WHERE is_active = TRUE AND capacity >= $1`
	args := []interface{}{c.Capacity}
	argCount := 1

	if c.TenantID != "" {
		argCount++
		query += fmt.Sprintf(" AND tenant_id = $%d", argCount)
		args = append(args, c.TenantID)
	}

	if c.Region != "" {
		argCount++
		query += fmt.Sprintf(" AND region = $%d", argCount)
		args = append(args, c.Region)
	}

	if c.AssetType != "" {
		argCount++
		query += fmt.Sprintf(" AND asset_type = $%d", argCount)
		args = append(args, c.AssetType)
	}

	// Restricted (Top Management) visibility
	if requestingUser.Role != user.RoleSecretary || requestingUser.Grade != "SDO" {
		query += ` AND asset_type != 'Top Management'`
	}
	if requestingUser.Role == user.RoleGeneralUser {
		query += ` AND is_restricted = FALSE`
	}

	argCount++
	startTimeIdx := argCount
	args = append(args, c.StartTime)
	argCount++
	endTimeIdx := argCount
	args = append(args, c.EndTime)

	// Operating hours check. The explicit ::timestamptz casts force pgx's
	// prepared-statement parameter inference to bind these as timestamptz.
	// Without them, the first use ($N::date) makes the planner infer the
	// parameter as `date`, and then `(date AT TIME ZONE 'UTC')::time`
	// silently evaluates to 00:00:00 — every row fails the open/close check.
	query += fmt.Sprintf(`
AND (
    NOT EXISTS (SELECT 1 FROM resource_operating_hours WHERE resource_id = resources.id)
    OR
    EXISTS (SELECT 1 FROM resource_operating_hours oh
            WHERE oh.resource_id = resources.id
            AND oh.weekday = EXTRACT(DOW FROM ($%d::timestamptz)::date)
            AND oh.is_closed = FALSE
            AND oh.open_time <= ($%d::timestamptz AT TIME ZONE 'UTC')::time
            AND oh.close_time >= ($%d::timestamptz AT TIME ZONE 'UTC')::time)
)`, startTimeIdx, startTimeIdx, endTimeIdx)

	// Composite-aware availability:
	//  - exclusive resources: any overlapping booking on self / parent /
	//    any sibling makes the resource busy.
	//  - shared resources: only busy when overlapping bookings >=
	//    shared_capacity (gym = 10 → 11th request is rejected).
	query += fmt.Sprintf(`
AND id NOT IN (
  WITH overlap_counts AS (
    SELECT resource_id, COUNT(*) AS n FROM bookings
     WHERE status IN ('Confirmed','Pending Approval','Checked In')
       AND start_time < $%d AND end_time > $%d
     GROUP BY resource_id
  ),
  busy_excl AS (
    SELECT oc.resource_id FROM overlap_counts oc
     JOIN resources r ON r.id = oc.resource_id
     WHERE r.booking_mode = 'exclusive' OR r.booking_mode IS NULL
  ),
  busy_shared AS (
    SELECT oc.resource_id FROM overlap_counts oc
     JOIN resources r ON r.id = oc.resource_id
     WHERE r.booking_mode = 'shared' AND oc.n >= GREATEST(r.shared_capacity, 1)
  )
  SELECT r.id FROM resources r
   WHERE r.id IN (SELECT resource_id FROM busy_excl)
      OR r.parent_resource_id IN (SELECT resource_id FROM busy_excl)
      OR r.id IN (SELECT parent_resource_id FROM resources WHERE id IN (SELECT resource_id FROM busy_excl))
      OR r.id IN (SELECT resource_id FROM busy_shared)
)
ORDER BY (composite_mode = 'parent') DESC, name`, endTimeIdx, startTimeIdx)

	log.Printf("FindAvailable query:\n%s\nArgs: %+v\n", query, args)

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("database query failed: %w", err)
	}
	defer rows.Close()

	var results []booking.Resource
	for rows.Next() {
		res, err := scanResource(rows)
		if err != nil {
			log.Printf("scan resource: %v", err)
			continue
		}
		results = append(results, res)
	}
	return results, nil
}

func (r *ResourceRepo) GetByID(ctx context.Context, id string) (*booking.Resource, error) {
	row := r.db.QueryRow(ctx,
		`SELECT `+resourceColumns+` FROM resources WHERE id = $1`, id)
	res, err := scanResource(row)
	if err != nil {
		return nil, fmt.Errorf("get resource: %w", err)
	}
	return &res, nil
}

func (r *ResourceRepo) Save(ctx context.Context, res booking.Resource) error {
	equipmentJSON, _ := json.Marshal(orEmpty(res.Equipment))
	metadataJSON, _ := json.Marshal(orEmptyMap(res.Metadata))
	// approver_ids / secretary_ids are postgres UUID[] columns. pgx encodes
	// a Go []string directly into a postgres array literal — JSON-marshalling
	// would produce "[]" which postgres rejects with malformed array literal.
	approverIDs := validUUIDs(res.ApproverIDs)
	secretaryIDs := validUUIDs(res.SecretaryIDs)

	mode := res.BookingMode
	if mode == "" {
		mode = booking.BookingModeExclusive
	}
	sharedCap := res.SharedCapacity
	if sharedCap < 1 {
		sharedCap = 1
	}
	const query = `
INSERT INTO resources (id, tenant_id, name, asset_type, region, location, capacity,
    equipment, is_restricted, requires_approval, approver_ids, secretary_ids, metadata,
    is_active, version, parent_resource_id, composite_mode, sub_resource_count, department_id,
    booking_mode, shared_capacity, color, icon)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1,
        NULLIF($15,'')::uuid, NULLIF($16,''), $17, NULLIF($18,'')::uuid,
        $20, $21, NULLIF($22,''), NULLIF($23,''))
ON CONFLICT (id) DO UPDATE
SET name              = EXCLUDED.name,
    asset_type        = EXCLUDED.asset_type,
    region            = EXCLUDED.region,
    location          = EXCLUDED.location,
    capacity          = EXCLUDED.capacity,
    equipment         = EXCLUDED.equipment,
    is_restricted     = EXCLUDED.is_restricted,
    requires_approval = EXCLUDED.requires_approval,
    approver_ids      = EXCLUDED.approver_ids,
    secretary_ids     = EXCLUDED.secretary_ids,
    metadata          = EXCLUDED.metadata,
    is_active         = EXCLUDED.is_active,
    parent_resource_id = EXCLUDED.parent_resource_id,
    composite_mode    = EXCLUDED.composite_mode,
    sub_resource_count = EXCLUDED.sub_resource_count,
    department_id     = EXCLUDED.department_id,
    booking_mode      = EXCLUDED.booking_mode,
    shared_capacity   = EXCLUDED.shared_capacity,
    color             = EXCLUDED.color,
    icon              = EXCLUDED.icon,
    version           = resources.version + 1
WHERE resources.version = $19`

	cmdTag, err := r.db.Exec(ctx, query,
		res.ID, res.TenantID, res.Name, res.AssetType, res.Region, res.Location, res.Capacity,
		equipmentJSON, res.IsRestricted, res.RequiresApproval, approverIDs, secretaryIDs,
		metadataJSON, res.IsActive,
		res.ParentResourceID, res.CompositeMode, max1(res.SubResourceCount), res.DepartmentID,
		res.Version,
		mode, sharedCap, res.Color, res.Icon,
	)
	if err != nil {
		return fmt.Errorf("save resource: %w", err)
	}
	if cmdTag.RowsAffected() == 0 {
		return fmt.Errorf("optimistic locking conflict: resource was modified")
	}
	return nil
}

func (r *ResourceRepo) ListByTenant(ctx context.Context, tenantID string) ([]booking.Resource, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+resourceColumns+` FROM resources WHERE tenant_id = $1 ORDER BY (composite_mode = 'parent') DESC, name`,
		tenantID)
	if err != nil {
		return nil, fmt.Errorf("list resources: %w", err)
	}
	defer rows.Close()
	var out []booking.Resource
	for rows.Next() {
		res, err := scanResource(rows)
		if err != nil {
			log.Printf("scan resource: %v", err)
			continue
		}
		out = append(out, res)
	}
	return out, nil
}

func (r *ResourceRepo) ListChildren(ctx context.Context, parentID string) ([]booking.Resource, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+resourceColumns+` FROM resources WHERE parent_resource_id = $1 ORDER BY name`, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []booking.Resource
	for rows.Next() {
		res, err := scanResource(rows)
		if err != nil {
			log.Printf("scan child resource: %v", err)
			continue
		}
		out = append(out, res)
	}
	return out, nil
}

func (r *ResourceRepo) Deactivate(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `UPDATE resources SET is_active = FALSE WHERE id = $1`, id)
	return err
}

// scanResource takes any pgx row interface (Row or Rows) and decodes a Resource.
type rowScanner interface {
	Scan(dest ...interface{}) error
}

func scanResource(row rowScanner) (booking.Resource, error) {
	var res booking.Resource
	var equipmentJSON, metadataJSON []byte
	var approverIDs, secretaryIDs []string
	err := row.Scan(
		&res.ID, &res.TenantID, &res.Name, &res.AssetType, &res.Region, &res.Location, &res.Capacity,
		&equipmentJSON, &res.IsRestricted, &res.RequiresApproval, &approverIDs, &secretaryIDs,
		&metadataJSON, &res.IsActive, &res.Version,
		&res.ParentResourceID, &res.CompositeMode, &res.SubResourceCount, &res.DepartmentID,
		&res.BookingMode, &res.SharedCapacity, &res.Color, &res.Icon,
	)
	if err != nil {
		return res, err
	}
	res.ApproverIDs = approverIDs
	res.SecretaryIDs = secretaryIDs
	if len(equipmentJSON) > 0 && string(equipmentJSON) != "null" {
		json.Unmarshal(equipmentJSON, &res.Equipment)
	}
	if len(metadataJSON) > 0 && string(metadataJSON) != "null" {
		json.Unmarshal(metadataJSON, &res.Metadata)
	}
	return res, nil
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
func orEmptyMap(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return map[string]interface{}{}
	}
	return m
}
func max1(n int) int {
	if n < 1 {
		return 1
	}
	return n
}

// validUUIDs filters out empty / non-UUID entries before sending the slice to
// a postgres UUID[] column. Postgres rejects the whole array if any element
// fails to parse, so admin UIs that submit a placeholder "" must not blow up
// the save.
func validUUIDs(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, err := uuid.Parse(s); err != nil {
			continue
		}
		out = append(out, s)
	}
	return out
}

func (r *ResourceRepo) GetOperatingHours(ctx context.Context, resourceID string) ([]booking.OperatingHours, error) {
	rows, err := r.db.Query(ctx,
		`SELECT resource_id, weekday, is_closed, open_time, close_time
           FROM resource_operating_hours WHERE resource_id = $1`, resourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []booking.OperatingHours
	for rows.Next() {
		h, err := scanOperatingHours(rows)
		if err != nil {
			log.Printf("scan operating hours: %v", err)
			continue
		}
		out = append(out, h)
	}
	return out, nil
}

func (r *ResourceRepo) SetOperatingHours(ctx context.Context, hours []booking.OperatingHours) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, h := range hours {
		_, err := tx.Exec(ctx, `
INSERT INTO resource_operating_hours (resource_id, weekday, is_closed, open_time, close_time)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (resource_id, weekday) DO UPDATE
SET is_closed = EXCLUDED.is_closed,
    open_time = EXCLUDED.open_time,
    close_time = EXCLUDED.close_time`,
			h.ResourceID, h.Weekday, h.IsClosed, h.OpenTime, h.CloseTime)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func scanOperatingHours(row rowScanner) (booking.OperatingHours, error) {
	var h booking.OperatingHours
	err := row.Scan(&h.ResourceID, &h.Weekday, &h.IsClosed, &h.OpenTime, &h.CloseTime)
	return h, err
}
