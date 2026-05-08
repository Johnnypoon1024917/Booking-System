package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/user"
)

type AdminHandler struct {
	adminUC *usecase.AdminManagerUseCase
}

func NewAdminHandler(adminUC *usecase.AdminManagerUseCase) *AdminHandler {
	return &AdminHandler{adminUC: adminUC}
}

func (h *AdminHandler) RegisterHoliday(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract the user role from the JWT context (secured by middleware)
	role := r.Context().Value("role").(string)
	if role != user.RoleSystemAdmin {
		http.Error(w, "Forbidden: Only System Admins can configure holidays", http.StatusForbidden)
		return
	}

	var req struct {
		Date        string `json:"date"`
		Description string `json:"description"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	targetDate, _ := time.Parse("2006-01-02", req.Date)

	err := h.adminUC.RegisterSystemHoliday(r.Context(), targetDate, req.Description, role)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"message": "FSD Holiday registered and blocking enabled."})
}
