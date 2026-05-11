
package booking

import "time"

// OperatingHours defines the weekly schedule for a resource.
type OperatingHours struct {
	ResourceID string
	Weekday    time.Weekday
	IsClosed   bool
	OpenTime   string
	CloseTime  string
}
