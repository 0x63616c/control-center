# Basemap provisioner image (www-hn1i): alpine + curl + the pmtiles CLI +
# provision.sh. Consumed three ways, all running the same script: the web
# Deployment's initContainer (if-missing mode), the monthly map-extract CronJob
# (force mode), and ad-hoc `kubectl create job --from=cronjob/map-extract`.
#
# The pmtiles binary is copied from the upstream go-pmtiles image (distroless,
# no shell) rather than re-downloading a release tarball: the version pin stays
# a normal image tag.
FROM ghcr.io/protomaps/go-pmtiles:v1.30.3 AS pmtiles

FROM alpine:3.24
RUN apk add --no-cache curl
COPY --from=pmtiles /go-pmtiles /usr/local/bin/pmtiles
COPY apps/map-provision/provision.sh /provision.sh
RUN chmod +x /provision.sh
CMD ["/provision.sh"]
