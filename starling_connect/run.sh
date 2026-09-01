#!/usr/bin/with-contenv bashio
# with-contenv puts SUPERVISOR_TOKEN and the add-on environment into scope.
bashio::log.info "Starting Starling Connect Bridge..."
exec node /app/src/index.js
