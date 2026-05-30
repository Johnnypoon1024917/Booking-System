package user

import "strings"

// Grade hierarchy for FSD's civil-service rank ladder. Approval rules use
// these ranks via Level.MinGrade — a step with MinGrade = "SDO" should be
// actionable by anyone at SDO *or higher*. The previous code used a
// case-insensitive string equality, which broke the "minimum" semantic
// (a DGFS approver was rejected on an SDO step).
//
// Grades not in this table are treated as rank 0, so unrecognised strings
// satisfy a MinGrade of "" but fail any named grade — which is the safe
// default. Tenants can extend the ladder here without touching the use case.
var gradeRank = map[string]int{
	"":      0,  // no grade / general user
	"SO":    10, // Station Officer
	"SSO":   20, // Senior Station Officer
	"ADO":   25, // Assistant Divisional Officer
	"DO":    30, // Divisional Officer
	"SDO":   40, // Senior Divisional Officer (the canonical Secretary-tier rank)
	"ADD":   50, // Assistant Deputy Director
	"DDGFS": 60, // Deputy Director
	"DGFS":  70, // Director of Fire Services
}

// Grades returns the configured ranks ordered from lowest to highest. The
// admin UI uses this list to populate the MinGrade dropdown on a rule
// level so admins don't free-type a typo that silently fails the check.
func Grades() []string {
	out := []string{"SO", "SSO", "ADO", "DO", "SDO", "ADD", "DDGFS", "DGFS"}
	return out
}

// GradeRank returns the configured rank for a grade (case-insensitive).
// Returns 0 for unknown grades.
func GradeRank(grade string) int {
	if r, ok := gradeRank[strings.ToUpper(strings.TrimSpace(grade))]; ok {
		return r
	}
	return 0
}

// GradeAtLeast reports whether `actual` meets or exceeds `required`.
// An empty `required` always passes (no grade gate set). An empty
// `actual` only passes when `required` is also empty.
func GradeAtLeast(actual, required string) bool {
	if strings.TrimSpace(required) == "" {
		return true
	}
	return GradeRank(actual) >= GradeRank(required)
}
