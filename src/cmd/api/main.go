package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/ad"
	"fsd-mrbs/src/infrastructure/postgres"
	"fsd-mrbs/src/infrastructure/rabbitmq"
	"fsd-mrbs/src/presentation/api/middleware"
)

func main() {
	ctx := context.Background()
	dbUrl := os.Getenv("DB_DSN")

	config, _ := pgxpool.ParseConfig(dbUrl)
	dbPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		log.Fatalf("DB Connection Failed: %v", err)
	}

	// Initialize Dependencies
	repo := postgres.NewBookingRepository(dbPool)
	pimmBroker := rabbitmq.NewRabbitMQPublisher(os.Getenv("RABBITMQ_URL"))
	bookingUC := usecase.NewCreateBookingUseCase(repo, pimmBroker)
	adService := ad.NewLDAPService("ldap://fsd.gov.hk:389")

	// HTTP Routing
	mux := http.NewServeMux()

	// 1. AD Login / SSO Endpoint
	mux.HandleFunc("/api/v1/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		// In production, parse JSON body. Here we mock from headers for testing.
		username := r.Header.Get("X-Username")
		password := r.Header.Get("X-Password")

		authUser, err := adService.Authenticate(r.Context(), username, password)
		if err != nil {
			http.Error(w, "Invalid Credentials", http.StatusUnauthorized)
			return
		}

		if !authUser.IsActive {
			http.Error(w, "Account Inactive", http.StatusForbidden)
			return
		}

		// Generate JWT Token
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub":  authUser.ID,
			"role": authUser.Role,
			"dn":   authUser.DN,
			"exp":  time.Now().Add(time.Hour * 8).Unix(),
		})
		tokenString, _ := token.SignedString(middleware.JwtSecretKey)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"token": tokenString, "role": authUser.Role})
	})

	// 2. Secured Booking Endpoint
	// Only GeneralUsers and RoomAdmins (and SystemAdmins by default) can book.
	securedBookingHandler := middleware.RequireRole([]string{user.RoleGeneralUser, user.RoleRoomAdmin}, func(w http.ResponseWriter, r *http.Request) {
		userID := r.Context().Value("userID").(string)
		_, err := bookingUC.Execute(r.Context(), "ROOM_A1", userID, time.Now(), time.Now().Add(time.Hour))
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"status": "success", "message": "FSD Booking Confirmed securely"}`))
	})

	mux.HandleFunc("/api/v1/bookings", securedBookingHandler)

	fileServer := http.FileServer(http.Dir("./src/presentation/web/public"))
	mux.Handle("/", fileServer)

	log.Println("FSD MRBS Secure Service Live on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
