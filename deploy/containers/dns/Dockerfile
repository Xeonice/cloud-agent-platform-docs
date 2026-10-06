FROM coredns/coredns:1.14.7@sha256:7efd3c635b03efd68c4e8398fc45f0d993d0e9ab016f72c1cefb0fd6d01aa286 AS coredns
FROM alpine:3.23.6@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
COPY --from=coredns /coredns /usr/local/bin/coredns
COPY Corefile /etc/coredns/Corefile
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=10s --start-period=15s --retries=3 CMD wget -q -O /dev/null http://127.0.0.2:2053/health && nslookup region1.v2.argotunnel.com 127.0.0.2 >/dev/null
ENTRYPOINT ["/usr/local/bin/coredns", "-conf", "/etc/coredns/Corefile"]
