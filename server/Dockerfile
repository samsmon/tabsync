FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /tabsync .
RUN mkdir /data

FROM scratch
COPY --from=build /tabsync /tabsync
COPY --from=build --chown=65534:65534 /data /data
USER 65534
ENV TABSYNC_DB=/data/tabsync.db TABSYNC_ADDR=:8080 GOMEMLIMIT=32MiB GOGC=50
EXPOSE 8080
ENTRYPOINT ["/tabsync"]
