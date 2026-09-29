# The insights pages: node and four files, and nothing else.
#
# No packages from npm. SQLite comes with node itself (node:sqlite), and the
# pages are written as strings, so there is nothing to install and nothing to
# keep up to date beyond the node image.

FROM node:24-alpine

# Copied in rather than mounted, like everything else here: a change to a file
# changes the image, and compose replaces the container.
COPY --chown=node:node package.json report.js render.js pages.js system.js server.js /home/node/insights/

USER node
WORKDIR /home/node/insights

ENV HOST=0.0.0.0 \
    PORT=5094 \
    NODE_NO_WARNINGS=1

EXPOSE 5094

CMD ["node", "server.js"]
