FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod ./
# Copy everything from the local folder to the container
COPY . .
# NEW: Diagnostic line - this will print the folder structure in your terminal during build
RUN find . -maxdepth 4 -name "main.go"
# Compile
RUN CGO_ENABLED=0 GOOS=linux go build -o /fsd-mrbs-api ./src/cmd/api/main.go

FROM alpine:latest
WORKDIR /root/
COPY --from=builder /fsd-mrbs-api .
COPY --from=builder /app/src/presentation/web/public ./src/presentation/web/public
EXPOSE 8080
CMD ["./fsd-mrbs-api"]