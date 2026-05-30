package handlers

import (
	"encoding/json"
	"fsd-mrbs/src/domain/booking"
	"net/http"
	"strings"
)

type AdminServiceHandler struct {
	repo booking.ServiceRepository
}

func NewAdminServiceHandler(repo booking.ServiceRepository) *AdminServiceHandler {
	return &AdminServiceHandler{repo: repo}
}

func (h *AdminServiceHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/services/")
	id = strings.Trim(id, "/")

	switch r.Method {
	case http.MethodGet:
		if id == "" {
			h.list(w, r)
		} else {
			h.get(w, r, id)
		}
	case http.MethodPost:
		h.create(w, r)
	case http.MethodPut, http.MethodPatch:
		h.update(w, r, id)
	case http.MethodDelete:
		h.delete(w, r, id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *AdminServiceHandler) list(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}

	services, err := h.repo.ListByTenant(r.Context(), tid.String())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, services)
}

func (h *AdminServiceHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	service, err := h.repo.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, service)
}

func (h *AdminServiceHandler) create(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}

	var s booking.Service
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	s.TenantID = tid.String()

	if err := h.repo.Save(r.Context(), &s); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

func (h *AdminServiceHandler) update(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}

	var s booking.Service
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	s.ID = id
	s.TenantID = tid.String()

	if err := h.repo.Save(r.Context(), &s); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (h *AdminServiceHandler) delete(w http.ResponseWriter, r *http.Request, id string) {
	if err := h.repo.Delete(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
