FROM debian:bookworm-slim

ARG SC2_VERSION=4.10
ARG SC2_BUILD=75689
ARG SC2_ZIP_PASSWORD=iagreetotheeula

WORKDIR /root

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget unzip ca-certificates \
    && wget -q "http://blzdistsc2-a.akamaihd.net/Linux/SC2.${SC2_VERSION}.zip" -O /tmp/SC2.zip \
    && unzip -q -P "${SC2_ZIP_PASSWORD}" /tmp/SC2.zip -d /root \
    && rm -f /tmp/SC2.zip \
    && rm -rf /root/StarCraftII/Battle.net /root/StarCraftII/Shaders \
    && rm -rf /root/StarCraftII/Maps \
    && mkdir -p /root/StarCraftII/Maps \
    && ln -s /root/StarCraftII/Maps /root/StarCraftII/maps \
    && apt-get purge -y wget unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV SC2_BUILD=${SC2_BUILD}

COPY entrypoint.sh /root/entrypoint.sh
RUN chmod +x /root/entrypoint.sh

EXPOSE 5001

ENTRYPOINT ["/root/entrypoint.sh"]
