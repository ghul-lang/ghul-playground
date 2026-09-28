# Prometheus with this repository's configuration in it.
#
# Built rather than pulled so that the configuration travels in the image. A
# bind mount of a single file pins the inode it was started with, and git writes
# a new file rather than editing in place, so a container started before a
# change never sees it - which is exactly what happened to the relabelling that
# gives each container its own series. It also means a configuration change
# replaces the container, which is what makes Prometheus read it: nothing
# watches that file.

ARG PROMETHEUS_VERSION=v3.15.0

FROM prom/prometheus:${PROMETHEUS_VERSION}

COPY prometheus.yml /etc/prometheus/prometheus.yml
