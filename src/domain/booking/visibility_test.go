package booking

import (
	"testing"

	"fsd-mrbs/src/domain/user"
)

// The matrix below pins the three-permission model so a refactor of
// visibility.go can't quietly widen access. Every cell maps a
// (caller-role, resource-kind, ownership, privacy) combination to the
// expected outcome on CanSeeDetails. If a row trips, the failure
// message reads as the actual ACL row, not a stack trace — making
// regressions easy to triage in CI.

func makeBooking(ownerID string, isPrivate bool) Booking {
	return Booking{
		ID:       "bk-1",
		TenantID: "t1",
		UserID:   ownerID,
		Status:   StatusConfirmed,
		IsPrivate: isPrivate,
	}
}

func makeResource(restricted bool, assetType string, acl []string) ResourceProjection {
	return ResourceProjection{
		ID:                   "r1",
		IsActive:             true,
		IsRestricted:         restricted,
		AssetType:            assetType,
		DetailsVisibleToRole: acl,
	}
}

func TestCanSeeDetails_Matrix(t *testing.T) {
	owner := Caller{UserID: "alice", Role: user.RoleGeneralUser}
	other := Caller{UserID: "bob", Role: user.RoleGeneralUser}
	sysAdmin := Caller{UserID: "root", Role: user.RoleSystemAdmin}
	secAdmin := Caller{UserID: "sec", Role: user.RoleSecurityAdmin}
	roomAdmin := Caller{UserID: "room", Role: user.RoleRoomAdmin}
	secretary := Caller{UserID: "sdo", Role: user.RoleSecretary, Grade: "SDO"}

	publicRoom := makeResource(false, "Room", nil)
	publicRoomWithGeneralACL := makeResource(false, "Room", []string{user.RoleGeneralUser})

	cases := []struct {
		name   string
		caller Caller
		book   Booking
		res    ResourceProjection
		want   bool
	}{
		// ---- owner always sees details ----------------------------
		{"owner sees own booking", owner, makeBooking("alice", false), publicRoom, true},
		{"owner sees own PRIVATE booking", owner, makeBooking("alice", true), publicRoom, true},

		// ---- System Admin sees everything (audit backstop) --------
		{"sysadmin sees public room booking", sysAdmin, makeBooking("alice", false), publicRoom, true},
		{"sysadmin sees private booking (override)", sysAdmin, makeBooking("alice", true), publicRoom, true},

		// ---- legacy default audience: admins + secretary ----------
		{"security admin sees public", secAdmin, makeBooking("alice", false), publicRoom, true},
		{"room admin sees public", roomAdmin, makeBooking("alice", false), publicRoom, true},
		{"secretary sees public", secretary, makeBooking("alice", false), publicRoom, true},

		// ---- private blocks the legacy audience ------------------
		{"security admin blocked by private", secAdmin, makeBooking("alice", true), publicRoom, false},
		{"room admin blocked by private", roomAdmin, makeBooking("alice", true), publicRoom, false},
		{"secretary blocked by private", secretary, makeBooking("alice", true), publicRoom, false},

		// ---- general user never sees details by default ----------
		{"general user blocked on public room", other, makeBooking("alice", false), publicRoom, false},

		// ---- per-resource ACL widens to general user -------------
		{"general user UNlocked by resource ACL", other, makeBooking("alice", false), publicRoomWithGeneralACL, true},
		{"general user STILL blocked when booking private",
			other, makeBooking("alice", true), publicRoomWithGeneralACL, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CanSeeDetails(tc.caller, tc.book, tc.res)
			if got != tc.want {
				t.Errorf("CanSeeDetails(role=%s, owner=%s, private=%v, acl=%v) = %v, want %v",
					tc.caller.Role, tc.book.UserID, tc.book.IsPrivate, tc.res.DetailsVisibleToRole, got, tc.want)
			}
		})
	}
}

func TestProjectBooking_StripsPIIForOutsiders(t *testing.T) {
	full := Booking{
		ID:             "bk-1",
		TenantID:       "t1",
		ResourceID:     "r1",
		UserID:         "alice",
		Status:         StatusConfirmed,
		Title:          "1:1 with CEO",
		MeetingURL:     "https://teams.example/secret",
		RedirectURL:    "https://x.example/redirect",
		ExceptionNotes: "Cancelled — confidential VIP visit",
	}
	res := makeResource(false, "Room", nil)
	outsider := Caller{UserID: "bob", Role: user.RoleGeneralUser}

	proj := ProjectBooking(outsider, full, res)

	if proj.Title != "" {
		t.Errorf("title not stripped: %q", proj.Title)
	}
	if proj.MeetingURL != "" {
		t.Errorf("meeting url not stripped: %q", proj.MeetingURL)
	}
	if proj.RedirectURL != "" {
		t.Errorf("redirect url not stripped: %q", proj.RedirectURL)
	}
	if proj.ExceptionNotes != "" {
		t.Errorf("exception notes not stripped: %q", proj.ExceptionNotes)
	}
	if proj.UserID != "" {
		t.Errorf("user id not stripped: %q", proj.UserID)
	}
	// Free/busy shape MUST survive — that's the whole point of the
	// projection (calendar still needs to render a block).
	if proj.Status != StatusConfirmed {
		t.Errorf("status lost: %q", proj.Status)
	}
	if proj.ResourceID == "" {
		t.Error("resource id lost")
	}
}

func TestProjectBooking_OwnerKeepsEverything(t *testing.T) {
	owner := Caller{UserID: "alice", Role: user.RoleGeneralUser}
	full := Booking{
		ID:         "bk-1",
		TenantID:   "t1",
		ResourceID: "r1",
		UserID:     "alice",
		Title:      "Sprint planning",
		Status:     StatusConfirmed,
		IsPrivate:  true, // shouldn't matter for the owner
	}
	res := makeResource(false, "Room", nil)
	proj := ProjectBooking(owner, full, res)
	if proj.Title != "Sprint planning" {
		t.Errorf("owner should keep title: %q", proj.Title)
	}
}

func TestResourceVisible_ExecRoomsHidden(t *testing.T) {
	execRoom := makeResource(false, "Top Management", nil)
	general := Caller{UserID: "u", Role: user.RoleGeneralUser}
	if ResourceVisible(general, execRoom) {
		t.Error("general user must not see Top Management room")
	}
	secSDO := Caller{UserID: "s", Role: user.RoleSecretary, Grade: "SDO"}
	if !ResourceVisible(secSDO, execRoom) {
		t.Error("Secretary (SDO) must see Top Management room")
	}
	secNonSDO := Caller{UserID: "s", Role: user.RoleSecretary, Grade: "EO"}
	if ResourceVisible(secNonSDO, execRoom) {
		t.Error("Secretary without SDO grade must not see Top Management room")
	}
	sys := Caller{UserID: "root", Role: user.RoleSystemAdmin}
	if !ResourceVisible(sys, execRoom) {
		t.Error("System Admin must see every resource")
	}
}

func TestCanSeeFreeBusy_FollowsVisibility(t *testing.T) {
	// The market-standard invariant: CanSeeFreeBusy must return the
	// same answer as ResourceVisible for every (caller, resource)
	// pair. If this test starts failing, the two functions have
	// drifted and the calendar will display ghost availability.
	roles := []Caller{
		{Role: user.RoleSystemAdmin},
		{Role: user.RoleSecurityAdmin},
		{Role: user.RoleRoomAdmin},
		{Role: user.RoleSecretary, Grade: "SDO"},
		{Role: user.RoleGeneralUser},
	}
	resources := []ResourceProjection{
		makeResource(false, "Room", nil),
		makeResource(true, "Room", nil),
		makeResource(false, "Top Management", nil),
		{IsActive: false, AssetType: "Room"},
	}
	for _, c := range roles {
		for _, r := range resources {
			if CanSeeFreeBusy(c, r) != ResourceVisible(c, r) {
				t.Errorf("free/busy diverged from visibility for role=%s asset=%s restricted=%v active=%v",
					c.Role, r.AssetType, r.IsRestricted, r.IsActive)
			}
		}
	}
}
