package handlers

import (
	"context"
	"net/http"

	"fsd-mrbs/src/domain/booking"
)

// ResourceCatalogLister is the slice of the resource repo this handler
// needs — satisfied by *postgres.ResourceRepo.
type ResourceCatalogLister interface {
	ListByTenant(ctx context.Context, tenantID string) ([]booking.Resource, error)
}

// ResourceCatalogHandler exposes a read-only room catalogue to every
// authenticated user (officers included) so the Calendar / Search views
// can render room columns. Creating a booking is still permission-gated
// elsewhere — this endpoint only lists active resources.
//
//	GET /api/v1/resources
type ResourceCatalogHandler struct {
	repo ResourceCatalogLister
}

func NewResourceCatalogHandler(repo ResourceCatalogLister) *ResourceCatalogHandler {
	return &ResourceCatalogHandler{repo: repo}
}

func (h *ResourceCatalogHandler) List(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	all, err := h.repo.ListByTenant(r.Context(), tenantID.String())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]booking.Resource, 0, len(all))
	for _, res := range all {
		if res.IsActive {
			out = append(out, res)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
