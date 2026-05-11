package usecase

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"

	"fsd-mrbs/src/domain/report"

	"github.com/xuri/excelize/v2"
)

type GenerateReportUseCase struct {
	repo report.ReportRepository
}

func NewGenerateReportUseCase(repo report.ReportRepository) *GenerateReportUseCase {
	return &GenerateReportUseCase{repo: repo}
}

// GenerateUsageCSV creates a downloadable CSV file buffer.
func (uc *GenerateReportUseCase) GenerateUsageCSV(ctx context.Context, start, end string) ([]byte, error) {
	data, err := uc.repo.GetUsageData(ctx, start, end)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	writer := csv.NewWriter(&buf)
	writer.Write([]string{"Resource Name", "Total Bookings", "Total Hours Utilised", "Peak Time"})
	for _, row := range data {
		writer.Write([]string{
			row.ResourceName,
			fmt.Sprintf("%d", row.TotalBookings),
			fmt.Sprintf("%.2f", row.TotalHours),
			row.PeakTime,
		})
	}
	writer.Flush()
	return buf.Bytes(), nil
}

// GenerateUsageXLSX produces an Excel workbook with a "Usage" sheet,
// styled headers and a usable column-width default. This satisfies the
// FSD requirement that all reports must be exportable to Excel or CSV.
func (uc *GenerateReportUseCase) GenerateUsageXLSX(ctx context.Context, start, end string) ([]byte, error) {
	data, err := uc.repo.GetUsageData(ctx, start, end)
	if err != nil {
		return nil, err
	}

	f := excelize.NewFile()
	defer f.Close()

	const sheet = "Usage"
	idx, err := f.NewSheet(sheet)
	if err != nil {
		return nil, err
	}
	f.SetActiveSheet(idx)
	f.DeleteSheet("Sheet1")

	headerStyle, _ := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"002147"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
	})

	headers := []string{"Resource Name", "Total Bookings", "Total Hours Utilised", "Peak Time"}
	for i, h := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue(sheet, cell, h)
		f.SetCellStyle(sheet, cell, cell, headerStyle)
	}

	for r, row := range data {
		f.SetCellValue(sheet, fmt.Sprintf("A%d", r+2), row.ResourceName)
		f.SetCellValue(sheet, fmt.Sprintf("B%d", r+2), row.TotalBookings)
		f.SetCellValue(sheet, fmt.Sprintf("C%d", r+2), row.TotalHours)
		f.SetCellValue(sheet, fmt.Sprintf("D%d", r+2), row.PeakTime)
	}

	f.SetColWidth(sheet, "A", "A", 32)
	f.SetColWidth(sheet, "B", "D", 22)

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
