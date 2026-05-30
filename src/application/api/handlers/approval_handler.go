package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/approval"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"
)

// PendingApprovalLister is implemented by the booking repository. Declared
// as an interface here so this handler doesn't import the postgres package.
type PendingApprovalLister interface {
	ListPendingForApprover(ctx context.Context, tenantID, approverID string) ([]booking.Booking, error)
}

// ChainDecider is implemented by ApprovalChainUseCase. We declare it as
// an interface here so the handler doesn't pull the chain package's
// build-time dependencies.
type ChainDecider interface {
	Decide(ctx context.Context, bookingID string, decider *user.User, status, reason string) error
}

// StepLister returns the chain steps materialized for a booking. Used to
// decide whether to route through the chain or fall back to single-level.
type StepLister interface {
	ListByBooking(ctx context.Context, bookingID string) ([]approval.Step, error)
}

// StepDelegator can reassign a pending step to another approver. The
// approval_step repo satisfies this (ListByBooking + Save).
type StepDelegator interface {
	ListByBooking(ctx context.Context, bookingID string) ([]approval.Step, error)
	Save(ctx context.Context, s approval.Step) error
}

// ApprovalHandler exposes the approval inbox + approve/reject actions.
//
//   GET  /api/v1/approvals                       list pending approvals visible to me
//   POST /api/v1/approvals/{booking_id}/approve  approve a pending booking
//   POST /api/v1/approvals/{booking_id}/reject   reject with reason
//   GET  /api/v1/approvals/{booking_id}/chain    chain progress (steps)
type ApprovalHandler struct {
	uc        *usecase.ApprovalUseCase
	chain     ChainDecider
	steps     StepLister
	delegator StepDelegator
	bookings  PendingApprovalLister
}

// NewApprovalHandler keeps backwards compatibility for callers that don't
// pass a chain. The chain + steps come in via WithChain when wired.
func NewApprovalHandler(uc *usecase.ApprovalUseCase, bookings PendingApprovalLister) *ApprovalHandler {
	return &ApprovalHandler{uc: uc, bookings: bookings}
}

func (h *ApprovalHandler) WithChain(decider ChainDecider, lister StepLister) *ApprovalHandler {
	h.chain = decider
	h.steps = lister
	return h
}

func (h *ApprovalHandler) WithDelegation(d StepDelegator) *ApprovalHandler {
	h.delegator = d
	return h
}

func (h *ApprovalHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	uid, _ := r.Context().Value("userID").(string)
	if uid == "" {
		http.Error(w, "user context missing", http.StatusUnauthorized)
		return
	}

	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/approvals"), "/")
	parts := strings.Split(path, "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		list, err := h.bookings.ListPendingForApprover(r.Context(), tenantID.String(), uid)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)

	case len(parts) == 2 && parts[1] == "chain" && r.Method == http.MethodGet:
		if h.steps == nil {
			writeJSON(w, http.StatusOK, []approval.Step{})
			return
		}
		out, err := h.steps.ListByBooking(r.Context(), parts[0])
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)

	case len(parts) == 2 && parts[1] == "approve" && r.Method == http.MethodPost:
		var body struct {
			Reason string `json:"reason"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := h.act(r, parts[0], approval.StepStatusApproved, body.Reason); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "approved"})

	case len(parts) == 2 && parts[1] == "delegate" && r.Method == http.MethodPost:
		var body struct {
			ToUserID string `json:"to_user_id"`
			Reason   string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ToUserID == "" {
			http.Error(w, "to_user_id required", http.StatusBadRequest)
			return
		}
		if err := h.delegate(r, parts[0], uid, body.ToUserID, body.Reason); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "delegated"})

	case len(parts) == 2 && parts[1] == "reject" && r.Method == http.MethodPost:
		var body struct {
			Reason string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Reason == "" {
			http.Error(w, "reason required", http.StatusBadRequest)
			return
		}
		if err := h.act(r, parts[0], approval.StepStatusRejected, body.Reason); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "rejected"})

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// act decides whether the booking is governed by an approval chain (one
// or more steps materialized) or by single-level approval, and routes
// accordingly. The chain path includes the current user's role + grade
// for multi-level authorization.
func (h *ApprovalHandler) act(r *http.Request, bookingID, status, reason string) error {
	uid, _ := r.Context().Value("userID").(string)
	if h.chain != nil && h.steps != nil {
		steps, err := h.steps.ListByBooking(r.Context(), bookingID)
		if err == nil && len(steps) > 0 {
			role, _ := r.Context().Value("userRole").(string)
			grade, _ := r.Context().Value("userGrade").(string)
			return h.chain.Decide(r.Context(), bookingID, &user.User{
				ID: uid, Role: role, Grade: grade,
			}, status, reason)
		}
	}
	if status == approval.StepStatusApproved {
		return h.uc.Approve(r.Context(), bookingID, uid, reason)
	}
	return h.uc.Reject(r.Context(), bookingID, uid, reason)
}

// delegate reassigns the first pending step of a booking to another
// approver. Recorded as a chain event (note appended to the step) rather
// than a silent reassignment, per the UX spec.
func (h *ApprovalHandler) delegate(r *http.Request, bookingID, fromUID, toUID, reason string) error {
	if h.delegator == nil {
		return errDelegationUnavailable
	}
	steps, err := h.delegator.ListByBooking(r.Context(), bookingID)
	if err != nil {
		return err
	}
	for _, s := range steps {
		if s.Status != approval.StepStatusPending {
			continue
		}
		s.ApproverIDs = []string{toUID}
		s.ApproverRole = ""
		note := "Delegated " + fromUID + " → " + toUID
		if reason != "" {
			note += " (" + reason + ")"
		}
		if s.Reason != "" {
			s.Reason = s.Reason + " · " + note
		} else {
			s.Reason = note
		}
		return h.delegator.Save(r.Context(), s)
	}
	return errNoPendingStep
}

var (
	errDelegationUnavailable = &delegateErr{"delegation is not available for this booking"}
	errNoPendingStep         = &delegateErr{"no pending approval step to delegate"}
)

type delegateErr struct{ msg string }

func (e *delegateErr) Error() string { return e.msg }
