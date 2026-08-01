# syntax=docker/dockerfile:1

FROM golang:1.26.5-trixie AS build
WORKDIR /src

COPY apps/software-factory/go.mod apps/software-factory/go.sum ./
RUN go mod download

COPY apps/software-factory/ ./
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/agent-poc-worker ./cmd/agent-poc-worker \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/agent-poc-run ./cmd/agent-poc-run

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/agent-poc-worker /usr/local/bin/agent-poc-worker
COPY --from=build /out/agent-poc-run /usr/local/bin/agent-poc-run
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/agent-poc-worker"]
