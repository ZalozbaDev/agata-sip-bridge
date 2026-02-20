FROM andrius/asterisk:20

USER root

# envsubst for rendering config templates
RUN apt-get update \
  && apt-get install -y --no-install-recommends gettext-base ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY conf/ /cfg/

ENTRYPOINT ["/entrypoint.sh"]

USER asterisk
