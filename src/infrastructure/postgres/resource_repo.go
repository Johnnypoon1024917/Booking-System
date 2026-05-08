package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ResourceRepo struct {
	db *pgxpool.Pool
}

func NewResourceRepo(db *pgxpool.Pool) *ResourceRepo {
	return &ResourceRepo{db: db}
}

// FindAvailable executes the advanced search engine with FSD RBAC rules applied
func (r *ResourceRepo) FindAvailable(ctx context.Context, c booking.SearchCriteria, requestingUser user.User) ([]booking.Resource, error) {
	// Base query: filter by capacity and region
	query := `
		SELECT id, name, asset_type, location, capacity, metadata->'equipment' as equipment, is_restricted
		FROM resources
		WHERE capacity >= $1 AND region = $2
	`
	args := []interface{}{c.Capacity, c.Region}
	argCount := 2

	// Dynamic Filter: Asset Type
	if c.AssetType != "" {
		argCount++
		query += fmt.Sprintf(" AND asset_type = $%d", argCount)
		args = append(args, c.AssetType)
	}

	// -------------------------------------------------------------------------
	// FSD BUSINESS LOGIC INJECTION
	// -------------------------------------------------------------------------

	// 1. Top Management Integration: Restricted to Secretary role with SDO grade
	if requestingUser.Role != user.RoleSecretary || requestingUser.Grade != "SDO" {
		query += ` AND asset_type != 'Top Management'`
	}

	// 2. Restricted Rooms: "VIP/Admin Only" visibility
	// General Users cannot see restricted assets in their search results
	if requestingUser.Role == user.RoleGeneralUser {
		query += ` AND is_restricted = FALSE`
	}

	// 3. Availability Validation: Real-time conflict detection
	// Exclude resources that have overlapping Confirmed, Pending, or Checked In bookings
	argCount++
	startTimeIdx := argCount
	args = append(args, c.StartTime)

	argCount++
	endTimeIdx := argCount
	args = append(args, c.EndTime)

	query += fmt.Sprintf(` AND id NOT IN (
		SELECT resource_id FROM bookings 
		WHERE status IN ('Confirmed', 'Pending Approval', 'Checked In') 
		AND (start_time < $%d AND end_time > $%d)
	)`, endTimeIdx, startTimeIdx)

	// -------------------------------------------------------------------------

	// Execute the query
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("database query failed: %w", err)
	}
	defer rows.Close()

	var results []booking.Resource

	// Iterate through the result set
	for rows.Next() {
		var res booking.Resource
		var equipmentJSON []byte // Intermediate variable for JSONB data

		err := rows.Scan(
			&res.ID,
			&res.Name,
			&res.AssetType,
			&res.Location,
			&res.Capacity,
			&equipmentJSON,
			&res.IsRestricted,
		)

		if err != nil {
			log.Printf("Row scanning error: %v", err)
			continue // Skip corrupted rows to maintain high availability
		}

		// Safely unmarshal the equipment JSONB array into the Go slice
		if len(equipmentJSON) > 0 && string(equipmentJSON) != "null" {
			if err := json.Unmarshal(equipmentJSON, &res.Equipment); err != nil {
				log.Printf("Failed to unmarshal equipment metadata for resource %s: %v", res.ID, err)
			}
		}

		results = append(results, res)
	}

	return results, nil
}
