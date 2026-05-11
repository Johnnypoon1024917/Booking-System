# FSD MRBS Platform — build, run, and ops commands.
.PHONY: all build api worker scheduler spa run-api run-worker run-scheduler test test-cov \
        migrate-up migrate-down migrate-reset migrate-version \
        docker-up docker-down docker-logs docker-rebuild db-connect clean

all: build

# ----------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------
build: api worker scheduler

api:
	go build -o api.exe ./src/cmd/api/

worker:
	go build -o worker.exe ./src/cmd/worker/

scheduler:
	go build -o scheduler.exe ./src/cmd/scheduler/

# Build the Vue 3 SPA (run after `npm install`).
spa:
	cd src/presentation/web/spa && npm run build

# Convenience: build SPA then start the API binary.
serve: spa api
	./api.exe

# ----------------------------------------------------------------------------
# Run (dev)
# ----------------------------------------------------------------------------
run-api:
	go run ./src/cmd/api/

run-worker:
	go run ./src/cmd/worker/

run-scheduler:
	go run ./src/cmd/scheduler/

# Start Vite dev server (auto-proxies /api and /api/v1/realtime to localhost:8080)
run-spa:
	cd src/presentation/web/spa && npm run dev

# ----------------------------------------------------------------------------
# Tests
# ----------------------------------------------------------------------------
test:
	go test -v ./...

test-cov:
	go test -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

# ----------------------------------------------------------------------------
# Migrations
# ----------------------------------------------------------------------------
migrate-up:
	./migrate.exe -action up

migrate-down:
	./migrate.exe -action down

migrate-reset:
	./migrate.exe -action reset

migrate-version:
	./migrate.exe -action version

migrate-force:
	./migrate.exe -action force $(VERSION)

# ----------------------------------------------------------------------------
# Docker
# ----------------------------------------------------------------------------
docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f

docker-rebuild:
	docker-compose down
	docker-compose build --no-cache
	docker-compose up -d

# ----------------------------------------------------------------------------
# Database / cleanup
# ----------------------------------------------------------------------------
db-connect:
	psql -h localhost -U mrbs_admin -d fsd_mrbs

clean:
	rm -f api.exe worker.exe scheduler.exe migrate.exe migrate
	rm -f coverage.out coverage.html
	rm -rf src/presentation/web/spa/dist src/presentation/web/spa/node_modules
