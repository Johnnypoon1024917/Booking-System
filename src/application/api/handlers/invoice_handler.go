// Charge-back / monthly invoice rollup.
//
//	POST /api/v1/admin/invoices/run?month=YYYY-MM     materialise drafts
//	GET  /api/v1/admin/invoices?status=Draft|Issued   list
//	GET  /api/v1/admin/invoices/{id}                  detail + line items
//	POST /api/v1/admin/invoices/{id}/issue            flip to Issued
//	POST /api/v1/admin/invoices/{id}/mark-paid        flip to Paid
//	GET  /api/v1/admin/invoices/{id}.csv              download
//
// "Run" walks every (cost_centre, period) tuple that has booking
// activity in the window and writes one Draft invoice per cost centre.
// Subtotal comes from booking_services.price × quantity. Tax is a flat
// % applied at issue time (TENANT_TAX_RATE env), with the line-level
// breakdown left intact for audit.
package handlers

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/infrastructure/auditlog"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5/pgxpool"
)

type InvoiceHandler struct {
	pool *pgxpool.Pool
}

func NewInvoiceHandler(pool *pgxpool.Pool) *InvoiceHandler {
	return &InvoiceHandler{pool: pool}
}

// Dispatch routes /api/v1/admin/invoices/* — the prefixes are short and
// distinct enough that a single dispatcher keeps the wiring tidy in
// main.go.
func (h *InvoiceHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/invoices")
	rest = strings.Trim(rest, "/")
	switch {
	case rest == "" && r.Method == http.MethodGet:
		h.list(w, r)
	case rest == "run" && r.Method == http.MethodPost:
		h.runRollup(w, r)
	case strings.HasSuffix(rest, "/issue"):
		h.setStatus(w, r, strings.TrimSuffix(rest, "/issue"), "Issued")
	case strings.HasSuffix(rest, "/mark-paid"):
		h.setStatus(w, r, strings.TrimSuffix(rest, "/mark-paid"), "Paid")
	case strings.HasSuffix(rest, ".csv"):
		h.exportCSV(w, r, strings.TrimSuffix(rest, ".csv"))
	case r.Method == http.MethodGet:
		h.detail(w, r, rest)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *InvoiceHandler) runRollup(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	month := r.URL.Query().Get("month")
	if month == "" {
		month = time.Now().Format("2006-01")
	}
	start, err := time.Parse("2006-01", month)
	if err != nil {
		http.Error(w, "month must be YYYY-MM", http.StatusBadRequest)
		return
	}
	// Per cost-centre rollup. We sum (price * quantity) on confirmed or
	// checked-in bookings whose end_time falls inside the period.
	tag, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), `
INSERT INTO invoices (tenant_id, cost_centre, period_start, period_end, subtotal, line_count, status)
SELECT b.tenant_id,
       COALESCE(NULLIF(b.cost_centre,''), 'UNASSIGNED'),
       $2::date, ($2::date + INTERVAL '1 month')::date,
       COALESCE(SUM(s.price * bs.quantity), 0),
       COUNT(bs.booking_id),
       'Draft'
FROM bookings b
LEFT JOIN booking_services bs ON bs.booking_id = b.id
LEFT JOIN services s ON s.id = bs.service_id
WHERE b.tenant_id = $1
  AND b.end_time >= $2::date AND b.end_time < ($2::date + INTERVAL '1 month')
  AND b.status IN ('Confirmed', 'Checked In')
GROUP BY b.tenant_id, COALESCE(NULLIF(b.cost_centre,''), 'UNASSIGNED')
ON CONFLICT (tenant_id, cost_centre, period_start) DO UPDATE
SET subtotal = EXCLUDED.subtotal,
    line_count = EXCLUDED.line_count,
    period_end = EXCLUDED.period_end`,
		tid, start.Format("2006-01-02"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Apply tax + total update in a second pass so we can change the
	// rate without re-running the aggregation.
	rate := taxRate()
	if _, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), `
UPDATE invoices
   SET tax = ROUND(subtotal * $3, 2),
       total = subtotal + ROUND(subtotal * $3, 2)
 WHERE tenant_id = $1 AND period_start = $2::date AND status = 'Draft'`,
		tid, start.Format("2006-01-02"), rate); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "INVOICE_ROLLUP_RUN",
		Severity:     audit.SeverityWarning,
		TargetEntity: "invoice",
		TargetID:     month,
		Next:         map[string]interface{}{"upserted": tag.RowsAffected()},
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"period":   month,
		"upserted": tag.RowsAffected(),
		"tax_rate": rate,
	})
}

func (h *InvoiceHandler) list(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	status := r.URL.Query().Get("status")
	q := `SELECT id, cost_centre, period_start, period_end, currency,
              subtotal, tax, total, line_count, status, issued_at, paid_at, created_at
        FROM invoices WHERE tenant_id = $1`
	args := []interface{}{tid}
	if status != "" {
		q += " AND status = $2"
		args = append(args, status)
	}
	q += " ORDER BY period_start DESC, cost_centre"
	rows, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Query(r.Context(), q, args...)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var (
			id, cc, currency, status string
			ps, pe                   time.Time
			subtotal, tax, total     float64
			lines                    int
			issuedAt, paidAt         *time.Time
			createdAt                time.Time
		)
		if err := rows.Scan(&id, &cc, &ps, &pe, &currency, &subtotal, &tax, &total,
			&lines, &status, &issuedAt, &paidAt, &createdAt); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": id, "cost_centre": cc, "period_start": ps, "period_end": pe,
			"currency": currency, "subtotal": subtotal, "tax": tax, "total": total,
			"line_count": lines, "status": status, "issued_at": issuedAt, "paid_at": paidAt,
			"created_at": createdAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *InvoiceHandler) detail(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var (
		costCentre, currency, status string
		ps, pe                       time.Time
		subtotal, tax, total         float64
	)
	if err := dbctx.ExecutorFromContext(r.Context(), h.pool).QueryRow(r.Context(), `
SELECT cost_centre, period_start, period_end, currency, subtotal, tax, total, status
FROM invoices WHERE id = $1 AND tenant_id = $2`,
		id, tid).Scan(&costCentre, &ps, &pe, &currency, &subtotal, &tax, &total, &status); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	lines, err := h.queryLines(r, id, tid.String(), costCentre, ps, pe)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "cost_centre": costCentre, "period_start": ps, "period_end": pe,
		"currency": currency, "subtotal": subtotal, "tax": tax, "total": total,
		"status": status, "lines": lines,
	})
}

type invoiceLine struct {
	BookingID   string    `json:"booking_id"`
	ResourceID  string    `json:"resource_id"`
	ResourceName string   `json:"resource_name"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
	Service     string    `json:"service"`
	Quantity    int       `json:"quantity"`
	UnitPrice   float64   `json:"unit_price"`
	Subtotal    float64   `json:"subtotal"`
}

func (h *InvoiceHandler) queryLines(r *http.Request, _, tenantID, costCentre string, ps, pe time.Time) ([]invoiceLine, error) {
	rows, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Query(r.Context(), `
SELECT b.id, b.resource_id, COALESCE(res.name,''), b.start_time, b.end_time,
       COALESCE(s.name,'(no service)'),
       COALESCE(bs.quantity, 0),
       COALESCE(s.price, 0),
       COALESCE(s.price, 0) * COALESCE(bs.quantity, 0)
FROM bookings b
LEFT JOIN resources res ON res.id = b.resource_id
LEFT JOIN booking_services bs ON bs.booking_id = b.id
LEFT JOIN services s ON s.id = bs.service_id
WHERE b.tenant_id = $1
  AND COALESCE(NULLIF(b.cost_centre,''), 'UNASSIGNED') = $2
  AND b.end_time >= $3 AND b.end_time < $4
  AND b.status IN ('Confirmed', 'Checked In')
ORDER BY b.start_time ASC`, tenantID, costCentre, ps, pe)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []invoiceLine
	for rows.Next() {
		var l invoiceLine
		if err := rows.Scan(&l.BookingID, &l.ResourceID, &l.ResourceName,
			&l.Start, &l.End, &l.Service, &l.Quantity, &l.UnitPrice, &l.Subtotal); err != nil {
			continue
		}
		out = append(out, l)
	}
	return out, nil
}

func (h *InvoiceHandler) setStatus(w http.ResponseWriter, r *http.Request, id, status string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var tsCol string
	switch status {
	case "Issued":
		tsCol = "issued_at"
	case "Paid":
		tsCol = "paid_at"
	default:
		http.Error(w, "unsupported status", http.StatusBadRequest)
		return
	}
	q := fmt.Sprintf(`UPDATE invoices SET status = $3, %s = NOW() WHERE id = $1 AND tenant_id = $2`, tsCol)
	if _, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), q, id, tid, status); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "INVOICE_" + strings.ToUpper(status),
		Severity:     audit.SeverityWarning,
		TargetEntity: "invoice",
		TargetID:     id,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *InvoiceHandler) exportCSV(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var (
		costCentre, currency string
		ps, pe               time.Time
	)
	if err := dbctx.ExecutorFromContext(r.Context(), h.pool).QueryRow(r.Context(), `
SELECT cost_centre, period_start, period_end, currency
FROM invoices WHERE id = $1 AND tenant_id = $2`,
		id, tid).Scan(&costCentre, &ps, &pe, &currency); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	lines, err := h.queryLines(r, id, tid.String(), costCentre, ps, pe)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="invoice-`+id+`.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"booking_id", "resource", "start", "end", "service", "quantity", "unit_price", "subtotal", "currency"})
	for _, l := range lines {
		_ = cw.Write(neutralizeCSV([]string{
			l.BookingID, l.ResourceName, l.Start.UTC().Format(time.RFC3339), l.End.UTC().Format(time.RFC3339),
			l.Service, strconv.Itoa(l.Quantity), fmt.Sprintf("%.2f", l.UnitPrice),
			fmt.Sprintf("%.2f", l.Subtotal), currency,
		}))
	}
	cw.Flush()
	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionDataExported,
		Severity:     audit.SeverityWarning,
		TargetEntity: "invoice",
		TargetID:     id,
		Next:         map[string]interface{}{"format": "csv", "lines": len(lines)},
	})
}

// neutralizeCSV protects against formula-injection on download, same
// rule as usecase.generate_report.neutralize. Inlined here so the handler
// doesn't depend on a use-case package.
func neutralizeCSV(in []string) []string {
	out := make([]string, len(in))
	for i, v := range in {
		if v != "" {
			switch v[0] {
			case '=', '+', '-', '@', '\t', '\r':
				out[i] = "'" + v
				continue
			}
		}
		out[i] = v
	}
	return out
}

func taxRate() float64 {
	if v := strings.TrimSpace(os.Getenv("TENANT_TAX_RATE")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			return f
		}
	}
	return 0
}
