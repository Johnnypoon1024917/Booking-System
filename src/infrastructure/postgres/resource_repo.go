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

// ProjectionsForIDs returns the minimal per-resource subset needed by
// domain/booking/visibility.go's policy: ACL + flags. We pull these in
// one round-trip rather than per booking so list endpoints stay O(1).
//
// Unknown ids are silently omitted; visibility.ProjectMany defaults to
// a permissive-default projection for those, which keeps a missing-row
// race safe (worst case is over-strict redaction).
func (r *ResourceRepo) ProjectionsForIDs(ctx context.Context, tenantID string, ids []string) (map[string]booking.ResourceProjection, error) {
	out := map[string]booking.ResourceProjection{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `
SELECT id::text, COALESCE(name,''), is_active, COALESCE(is_restricted, FALSE),
       COALESCE(asset_type,''),
       COALESCE(details_visible_to_role, ARRAY[]::TEXT[])
FROM resources WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
		tenantID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p booking.ResourceProjection
		var acl []string
		if err := rows.Scan(&p.ID, &p.Name, &p.IsActive, &p.IsRestricted, &p.AssetType, &acl); err != nil {
			return nil, err
		}
		p.DetailsVisibleToRole = acl
		out[p.ID] = p
	}
	return out, nil
}

const resourceColumns = `id, tenant_id, name, asset_type, region, location, capacity, equipment,
    is_restricted, requires_approval, approver_ids, secretary_ids, metadata, is_active, version,
    COALESCE(parent_resource_id::text, ''), COALESCE(composite_mode, ''), sub_resource_count,
    COALESCE(department_id::text, ''),
    COALESCE(booking_mode, 'exclusive'), COALESCE(shared_capacity, 1),
    COALESCE(color, ''), COALESCE(icon, ''),
    COALESCE(floor_x, 0), COALESCE(floor_y, 0),
    COALESCE(details_visible_to_role, ARRAY[]::TEXT[])`

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

	if c.Location != "" {
		// The admin form populates `region` (the high-level geographic
		// bucket) and `location` (the specific building/floor) as two
		// separate fields, but the search form only collects one box.
		// Match against EITHER so a search for "Hong Kong" finds rooms
		// whose region is "Hong Kong" even if they have no sub-location.
		argCount++
		query += fmt.Sprintf(" AND (location = $%d OR region = $%d)", argCount, argCount)
		args = append(args, c.Location)
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

	// Tenant timezone for the overlap comparison (QA #1). The SPA sends the
	// search window as a wall-clock time which pgx binds as a UTC instant
	// (e.g. 15:00 → 15:00Z). Stored bookings, by contrast, are true UTC
	// instants derived from the booker's local time (15:00 local → 07:00Z).
	// We therefore reinterpret the window's wall-clock digits in this zone
	// before comparing, so a 15:00 local search overlaps a 15:00-local
	// (07:00Z) booking. Operating-hours comparison below is unaffected — it
	// deliberately keeps the wall-clock value.
	argCount++
	tzIdx := argCount
	tz := c.Timezone
	if tz == "" {
		tz = "Asia/Hong_Kong"
	}
	args = append(args, tz)

	// Operating hours check. The explicit ::timestamptz casts force pgx's
	// prepared-statement parameter inference to bind these as timestamptz.
	// Without them, the first use ($N::date) makes the planner infer the
	// parameter as `date`, and then `(date AT TIME ZONE 'UTC')::time`
	// silently evaluates to 00:00:00 — every row fails the open/close check.
	if c.AllDay {
		// All-day event: the booking is not constrained to the room's
		// open/close window, so we only require the room to be open at all
		// on that weekday. A room with normal 09:00–17:00 hours therefore
		// matches an all-day search; only a day marked is_closed is
		// excluded. (QA #2 — previously an all-day search demanded the room
		// be open the full 00:00–23:59 window, i.e. effectively 24h.)
		query += fmt.Sprintf(`
AND (
    NOT EXISTS (SELECT 1 FROM resource_operating_hours WHERE resource_id = resources.id)
    OR
    EXISTS (SELECT 1 FROM resource_operating_hours oh
            WHERE oh.resource_id = resources.id
            AND oh.weekday = EXTRACT(DOW FROM ($%d::timestamptz)::date)
            AND oh.is_closed = FALSE)
)`, startTimeIdx)
	} else {
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
	}

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
       AND start_time < (($%d::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE $%d)
       AND end_time   > (($%d::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE $%d)
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
ORDER BY (composite_mode = 'parent') DESC, name`, endTimeIdx, tzIdx, startTimeIdx, tzIdx)

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
	// detailsACL is stored as TEXT[]; we coerce nil → empty slice so the
	// COALESCE in the read path can rely on a real array. NULL would
	// also work but pgx serialises Go nil to NULL anyway, and the empty
	// slice is unambiguous when read back.
	detailsACL := res.DetailsVisibleToRole
	if detailsACL == nil {
		detailsACL = []string{}
	}
	const query = `
INSERT INTO resources (id, tenant_id, name, asset_type, region, location, capacity,
    equipment, is_restricted, requires_approval, approver_ids, secretary_ids, metadata,
    is_active, version, parent_resource_id, composite_mode, sub_resource_count, department_id,
    booking_mode, shared_capacity, color, icon, floor_x, floor_y, details_visible_to_role)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1,
        NULLIF($15,'')::uuid, NULLIF($16,''), $17, NULLIF($18,'')::uuid,
        $20, $21, NULLIF($22,''), NULLIF($23,''), $24, $25, $26::text[])
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
    floor_x           = EXCLUDED.floor_x,
    floor_y           = EXCLUDED.floor_y,
    details_visible_to_role = EXCLUDED.details_visible_to_role,
    version           = resources.version + 1
WHERE resources.version = $19`

	cmdTag, err := r.db.Exec(ctx, query,
		res.ID, res.TenantID, res.Name, res.AssetType, res.Region, res.Location, res.Capacity,
		equipmentJSON, res.IsRestricted, res.RequiresApproval, approverIDs, secretaryIDs,
		metadataJSON, res.IsActive,
		res.ParentResourceID, res.CompositeMode, max1(res.SubResourceCount), res.DepartmentID,
		res.Version,
		mode, sharedCap, res.Color, res.Icon,
		clampPct(res.FloorX), clampPct(res.FloorY),
		detailsACL,
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
	var approverIDs, secretaryIDs, detailsACL []string
	err := row.Scan(
		&res.ID, &res.TenantID, &res.Name, &res.AssetType, &res.Region, &res.Location, &res.Capacity,
		&equipmentJSON, &res.IsRestricted, &res.RequiresApproval, &approverIDs, &secretaryIDs,
		&metadataJSON, &res.IsActive, &res.Version,
		&res.ParentResourceID, &res.CompositeMode, &res.SubResourceCount, &res.DepartmentID,
		&res.BookingMode, &res.SharedCapacity, &res.Color, &res.Icon,
		&res.FloorX, &res.FloorY,
		&detailsACL,
	)
	if err != nil {
		return res, err
	}
	res.ApproverIDs = approverIDs
	res.SecretaryIDs = secretaryIDs
	res.DetailsVisibleToRole = detailsACL
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

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
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
	// open_time / close_time are postgres TIME columns; cast them to text so
	// they scan into the Go string fields. Without the cast pgx fails to scan
	// TIME -> *string, every row is dropped, and GetOperatingHours returns an
	// empty slice — which made the Resource Editor silently fall back to the
	// default 09:00–17:00 hours on every reopen even though the real hours
	// were saved (QA #3). COALESCE guards rows where the time is NULL.
	rows, err := r.db.Query(ctx,
		`SELECT resource_id, weekday, is_closed,
		        COALESCE(open_time::text, ''), COALESCE(close_time::text, '')
           FROM resource_operating_hours WHERE resource_id = $1
          ORDER BY weekday`, resourceID)
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
